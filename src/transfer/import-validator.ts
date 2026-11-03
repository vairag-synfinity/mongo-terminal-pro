import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Document } from '../utils/bson.js';
import { validateDocument } from '../utils/validation.js';

export type TransferFormat = 'json' | 'csv' | 'bson';

export function detectFormat(file: string): TransferFormat | undefined {
  const lower = file.toLowerCase().replace(/\.gz$/, '');
  if (lower.endsWith('.json') || lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'json';
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'csv';
  if (lower.endsWith('.bson')) return 'bson';
  return undefined;
}

export interface ImportFileCheck {
  path: string;
  size: number;
  format: TransferFormat;
  gzip: boolean;
}

/** Validates an import file path before any reading happens. */
export async function checkImportFile(file: string, format?: TransferFormat): Promise<ImportFileCheck> {
  const resolved = path.resolve(file.trim().replace(/^["']|["']$/g, ''));
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!stat.isFile()) throw new Error(`Not a regular file: ${resolved}`);
  const detected = format ?? detectFormat(resolved);
  if (!detected)
    throw new Error('Unknown file type. Use .json, .jsonl, .csv or .bson, or choose the format explicitly.');
  const handle = await fs.open(resolved, 'r');
  try {
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    return { path: resolved, size: stat.size, format: detected, gzip: head[0] === 0x1f && head[1] === 0x8b };
  } finally {
    await handle.close();
  }
}

export interface ImportIssue {
  /** Zero-based record index in the file. */
  index: number;
  /** Line (JSON/CSV) or byte offset (BSON) where the record starts. */
  location?: string;
  message: string;
}

/** Validates a document that is about to be imported. */
export function validateImportDocument(
  doc: Document,
  index: number,
  location?: string,
  requiredKeys: string[] = [],
): ImportIssue[] {
  const issues = validateDocument(doc).map((i) => ({
    index,
    location,
    message: i.path ? `${i.path}: ${i.message}` : i.message,
  }));
  for (const key of requiredKeys) {
    if (getDotted(doc, key) === undefined)
      issues.push({ index, location, message: `Missing upsert key field "${key}"` });
  }
  return issues;
}

function getDotted(doc: Document, key: string): unknown {
  let node: unknown = doc;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

export { getDotted };
