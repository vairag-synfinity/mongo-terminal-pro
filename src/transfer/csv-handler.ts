import { bsonType, Long, ObjectId, type Document } from '../utils/bson.js';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import type { Readable, Writable } from 'node:stream';
import { isPlainObject } from '../utils/validation.js';
import { serializeJsonDocument, toPlainJson, writeChunk } from './json-handler.js';

export type CsvFieldType =
  'auto' | 'string' | 'number' | 'int' | 'boolean' | 'date' | 'objectId' | 'json' | 'skip';

export interface CsvFieldMapping {
  /** Column header in the CSV file. */
  source: string;
  /** Target field path; dots create nested documents ("address.city"). */
  target: string;
  type: CsvFieldType;
}

export interface CsvReadOptions {
  delimiter?: string;
  /** How to treat empty cells: omit the field (default), store null, or keep "". */
  emptyValues?: 'omit' | 'null' | 'empty-string';
}

export interface CsvRow {
  index: number;
  line: number;
  record: Record<string, string>;
}

export function csvParser(options: CsvReadOptions = {}) {
  return parse({
    columns: (header: string[]) => header.map((h) => h.replace(/^\uFEFF/, '').trim()),
    delimiter: options.delimiter ?? ',',
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: false,
    max_record_size: 16 * 1024 * 1024,
    info: true,
  });
}

/** Streams CSV rows as header-keyed records. */
export async function* readCsvRows(stream: Readable, options: CsvReadOptions = {}): AsyncGenerator<CsvRow> {
  const parser = stream.pipe(csvParser(options));
  let index = 0;
  for await (const item of parser as AsyncIterable<{
    record: Record<string, string>;
    info: { lines: number };
  }>) {
    yield { index: index++, line: item.info.lines, record: item.record };
  }
}

const INT_RE = /^-?(0|[1-9]\d*)$/;
const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Conservative type inference: leading zeros, phone numbers etc. stay strings. */
export function inferCsvValue(raw: string): unknown {
  if (raw === 'true' || raw === 'TRUE') return true;
  if (raw === 'false' || raw === 'FALSE') return false;
  if (raw === 'null' || raw === 'NULL') return null;
  if (INT_RE.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : Long.fromString(raw);
  }
  if (NUMBER_RE.test(raw)) return Number(raw);
  if (ISO_DATETIME_RE.test(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return raw;
}

export function convertCsvValue(raw: string, type: CsvFieldType): unknown {
  switch (type) {
    case 'string':
      return raw;
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n) || raw.trim() === '') throw new Error(`"${raw}" is not a number`);
      return n;
    }
    case 'int': {
      if (!INT_RE.test(raw.trim())) throw new Error(`"${raw}" is not an integer`);
      const n = Number(raw);
      return Number.isSafeInteger(n) ? n : Long.fromString(raw.trim());
    }
    case 'boolean': {
      const v = raw.trim().toLowerCase();
      if (['true', '1', 'yes', 'y'].includes(v)) return true;
      if (['false', '0', 'no', 'n'].includes(v)) return false;
      throw new Error(`"${raw}" is not a boolean`);
    }
    case 'date': {
      const d = /^\d+$/.test(raw.trim()) ? new Date(Number(raw)) : new Date(raw);
      if (Number.isNaN(d.getTime())) throw new Error(`"${raw}" is not a date`);
      return d;
    }
    case 'objectId':
      if (!/^[0-9a-fA-F]{24}$/.test(raw.trim())) throw new Error(`"${raw}" is not an ObjectId`);
      return new ObjectId(raw.trim());
    case 'json':
      return JSON.parse(raw);
    case 'auto':
      return inferCsvValue(raw);
    case 'skip':
      return undefined;
  }
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype')
      throw new Error(`Invalid field name "${path}"`);
    const existing = node[key];
    if (!isPlainObject(existing)) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1] as string;
  if (leaf === '__proto__') throw new Error(`Invalid field name "${path}"`);
  node[leaf] = value;
}

export function defaultMapping(headers: string[]): CsvFieldMapping[] {
  return headers.map((h) => ({ source: h, target: h, type: 'auto' }));
}

/** Converts a CSV record to a document according to the mapping. Throws on conversion errors. */
export function csvRecordToDocument(
  record: Record<string, string>,
  mapping: CsvFieldMapping[] | undefined,
  options: CsvReadOptions = {},
): Document {
  const doc: Record<string, unknown> = {};
  const fields = mapping ?? defaultMapping(Object.keys(record));
  const errors: string[] = [];
  for (const field of fields) {
    if (field.type === 'skip') continue;
    const raw = record[field.source];
    if (raw === undefined || raw === '') {
      if (options.emptyValues === 'null') setPath(doc, field.target, null);
      else if (options.emptyValues === 'empty-string') setPath(doc, field.target, '');
      continue;
    }
    try {
      setPath(doc, field.target, convertCsvValue(raw, field.type));
    } catch (error) {
      errors.push(`${field.source}: ${(error as Error).message}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join('; '));
  return doc;
}

/** Reads the first rows for preview / mapping. */
export async function previewCsv(
  stream: Readable,
  rows = 5,
  options: CsvReadOptions = {},
): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const out: Record<string, string>[] = [];
  let headers: string[] = [];
  for await (const row of readCsvRows(stream, options)) {
    if (headers.length === 0) headers = Object.keys(row.record);
    out.push(row.record);
    if (out.length >= rows) break;
  }
  stream.destroy();
  return { headers, rows: out };
}

// ------------------------------------------------------------------------------------------------
// Export
// ------------------------------------------------------------------------------------------------

export function getPath(doc: unknown, path: string): unknown {
  let node: unknown = doc;
  for (const part of path.split('.')) {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Collects dotted field paths (objects flattened, arrays kept whole) from sample documents. */
export function inferCsvFields(docs: Document[], maxFields = 200): string[] {
  const fields = new Set<string>();
  const visit = (value: unknown, prefix: string, depth: number) => {
    if (fields.size >= maxFields) return;
    if (isPlainObject(value) && depth < 5 && Object.keys(value).length > 0) {
      for (const [k, v] of Object.entries(value)) visit(v, prefix ? `${prefix}.${k}` : k, depth + 1);
    } else if (prefix) {
      fields.add(prefix);
    }
  };
  for (const d of docs) visit(d, '', 0);
  const list = [...fields];
  return list.includes('_id') ? ['_id', ...list.filter((f) => f !== '_id')] : list;
}

export function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  const t = bsonType(value);
  if (t === 'ObjectId') return (value as ObjectId).toHexString();
  if (t === 'Decimal128' || t === 'Long') return String(value);
  if (typeof value === 'object') {
    const plain = toPlainJson(value);
    if (typeof plain !== 'object' || plain === null) return String(plain ?? '');
    return serializeJsonDocument(value as Document, 'relaxed');
  }
  return String(value);
}

export class CsvDocumentWriter {
  private readonly stringifier: ReturnType<typeof stringify>;
  bytes = 0;
  private readonly pump: Promise<void>;

  constructor(
    private readonly out: Writable,
    private readonly fields: string[],
    delimiter = ',',
  ) {
    const stringifier = stringify({ header: true, columns: fields, delimiter, bom: false });
    this.stringifier = stringifier;
    this.pump = (async () => {
      for await (const chunk of stringifier) {
        this.bytes += await writeChunk(out, chunk as string);
      }
    })();
  }

  async write(doc: Document): Promise<void> {
    const row = this.fields.map((f) => csvCell(getPath(doc, f)));
    if (!this.stringifier.write(row)) {
      await new Promise<void>((resolve) => this.stringifier.once('drain', () => resolve()));
    }
  }

  async end(): Promise<void> {
    this.stringifier.end();
    await this.pump;
  }
}
