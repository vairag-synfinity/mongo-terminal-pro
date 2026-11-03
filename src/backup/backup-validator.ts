import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { countBsonDocuments } from '../transfer/bson-handler.js';

/**
 * Verifies mongodump output:
 *  - directory layout: every <db>/<coll>.bson[.gz] is parsed end-to-end (length prefixes, null
 *    terminators, gzip CRC) and document counts are compared with what mongodump reported.
 *    Each collection must also have its .metadata.json[.gz].
 *  - archive layout: the archive magic number is checked and the whole file is streamed through
 *    gunzip when compressed (validating the CRC). Per-collection counts come from mongodump output.
 */

export const ARCHIVE_MAGIC = 0x8199e26d;

export interface NamespaceVerification {
  namespace: string;
  documents: number;
  bytes: number;
  hasMetadata: boolean;
  expectedDocuments?: number;
  ok: boolean;
  error?: string;
}

export interface BackupVerification {
  ok: boolean;
  layout: 'directory' | 'archive';
  namespaces: NamespaceVerification[];
  totalDocuments: number;
  sizeBytes: number;
  errors: string[];
  summary: string;
}

/** Parses "done dumping db.coll (123 documents)" lines from mongodump output. */
export function parseDumpCounts(output: string): Map<string, number> {
  const counts = new Map<string, number>();
  // mongodump >= 100.x quotes namespaces with backticks: done dumping `db.coll` (5 documents)
  for (const m of output.matchAll(/done dumping `?([^`\s]+)`? \((\d+) documents?\)/g)) {
    counts.set(m[1] as string, Number(m[2]));
  }
  return counts;
}

function safeDecode(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

async function directorySize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) total += (await fs.stat(full)).size;
  }
  return total;
}

function openMaybeGzip(file: string): Readable {
  const raw = createReadStream(file);
  return file.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
}

export async function listDumpNamespaces(
  dir: string,
): Promise<{ namespace: string; db: string; collection: string; bsonFile: string; metadataFile?: string }[]> {
  const out: {
    namespace: string;
    db: string;
    collection: string;
    bsonFile: string;
    metadataFile?: string;
  }[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const dbEntry of entries) {
    if (!dbEntry.isDirectory()) continue;
    const dbDir = path.join(dir, dbEntry.name);
    const files = await fs.readdir(dbDir);
    for (const f of files) {
      const match = /^(.*)\.bson(\.gz)?$/.exec(f);
      if (!match) continue;
      const collection = safeDecode(match[1] as string);
      const gz = match[2] ?? '';
      const metadata =
        files.find((x) => x === `${match[1]}.metadata.json${gz}`) ??
        files.find((x) => x === `${match[1]}.metadata.json`);
      out.push({
        namespace: `${dbEntry.name}.${collection}`,
        db: dbEntry.name,
        collection,
        bsonFile: path.join(dbDir, f),
        metadataFile: metadata ? path.join(dbDir, metadata) : undefined,
      });
    }
  }
  return out.sort((a, b) => a.namespace.localeCompare(b.namespace));
}

export async function verifyDirectoryBackup(
  dir: string,
  expected: Map<string, number> = new Map(),
): Promise<BackupVerification> {
  const errors: string[] = [];
  const namespaces: NamespaceVerification[] = [];
  const stat = await fs.stat(dir).catch(() => undefined);
  if (!stat?.isDirectory()) {
    return {
      ok: false,
      layout: 'directory',
      namespaces,
      totalDocuments: 0,
      sizeBytes: 0,
      errors: [`Backup directory not found: ${dir}`],
      summary: 'Backup directory missing',
    };
  }
  const found = await listDumpNamespaces(dir);
  for (const ns of found) {
    const v: NamespaceVerification = {
      namespace: ns.namespace,
      documents: 0,
      bytes: 0,
      hasMetadata: Boolean(ns.metadataFile),
      ok: true,
      expectedDocuments: expected.get(ns.namespace),
    };
    try {
      const { documents, bytes } = await countBsonDocuments(openMaybeGzip(ns.bsonFile));
      v.documents = documents;
      v.bytes = bytes;
      if (v.expectedDocuments !== undefined && v.expectedDocuments !== documents) {
        v.ok = false;
        v.error = `expected ${v.expectedDocuments} documents, found ${documents}`;
      }
      if (!v.hasMetadata) {
        v.ok = false;
        v.error = 'metadata file missing';
      }
    } catch (error) {
      v.ok = false;
      v.error = (error as Error).message;
    }
    if (!v.ok) errors.push(`${ns.namespace}: ${v.error}`);
    namespaces.push(v);
  }
  for (const ns of expected.keys()) {
    if (!found.some((f) => f.namespace === ns))
      errors.push(`${ns}: reported by mongodump but missing from the backup`);
  }
  if (found.length === 0 && expected.size === 0) errors.push('The backup contains no collections');
  const totalDocuments = namespaces.reduce((a, n) => a + n.documents, 0);
  const sizeBytes = await directorySize(dir);
  const ok = errors.length === 0;
  return {
    ok,
    layout: 'directory',
    namespaces,
    totalDocuments,
    sizeBytes,
    errors,
    summary: ok
      ? `Verified ${namespaces.length} collection(s), ${totalDocuments} document(s)`
      : `Verification failed: ${errors.length} problem(s)`,
  };
}

export async function verifyArchiveBackup(
  file: string,
  gzip: boolean,
  expected: Map<string, number> = new Map(),
): Promise<BackupVerification> {
  const errors: string[] = [];
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat?.isFile() || stat.size === 0) {
    return {
      ok: false,
      layout: 'archive',
      namespaces: [],
      totalDocuments: 0,
      sizeBytes: stat?.size ?? 0,
      errors: ['Archive file missing or empty'],
      summary: 'Archive missing',
    };
  }
  try {
    const stream = gzip ? createReadStream(file).pipe(createGunzip()) : createReadStream(file);
    let header: Buffer | undefined;
    for await (const chunk of stream) {
      if (!header) {
        header = chunk as Buffer;
        if (header.length < 4 || header.readUInt32LE(0) !== ARCHIVE_MAGIC) {
          errors.push('Not a mongodump archive (magic number mismatch)');
          stream.destroy();
          break;
        }
      }
      // Keep reading to validate the gzip CRC for compressed archives.
    }
  } catch (error) {
    errors.push(`Archive is corrupt: ${(error as Error).message}`);
  }
  const namespaces = [...expected.entries()].map(([namespace, documents]) => ({
    namespace,
    documents,
    bytes: 0,
    hasMetadata: true,
    expectedDocuments: documents,
    ok: true,
  }));
  const totalDocuments = namespaces.reduce((a, n) => a + n.documents, 0);
  const ok = errors.length === 0;
  return {
    ok,
    layout: 'archive',
    namespaces,
    totalDocuments,
    sizeBytes: stat.size,
    errors,
    summary: ok
      ? `Archive integrity verified; ${namespaces.length} collection(s), ${totalDocuments} document(s) reported`
      : `Verification failed: ${errors.join('; ')}`,
  };
}
