import type { Document, Filter, MongoClient, Sort } from 'mongodb';
import { constants as fsConstants, createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { CancelledError, ValidationError } from '../core/error-handler.js';
import { BsonDocumentWriter } from './bson-handler.js';
import { CsvDocumentWriter, inferCsvFields } from './csv-handler.js';
import type { TransferFormat } from './import-validator.js';
import { JsonDocumentWriter, type JsonLayout, type JsonMode } from './json-handler.js';
import { ProgressTracker, type ProgressCallback } from './transfer-progress.js';

export interface ExportOptions {
  database: string;
  /** Omit to export every collection of the database (one file per collection). */
  collection?: string;
  format: TransferFormat;
  /** File path for a collection export, directory for a database export. */
  output: string;
  overwrite?: boolean;
  filter?: Filter<Document>;
  projection?: Document;
  sort?: Sort;
  limit?: number;
  /** Explicit CSV columns / projection fields. */
  fields?: string[];
  /** Export these _id values only ("selected documents"). */
  ids?: unknown[];
  /** Aggregation pipeline instead of a find query. */
  pipeline?: Document[];
  batchSize: number;
  jsonMode?: JsonMode;
  jsonLayout?: JsonLayout;
  csvDelimiter?: string;
  maxTimeMS?: number;
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}

export interface ExportedFile {
  collection: string;
  path: string;
  documents: number;
  bytes: number;
}

export interface ExportSummary {
  files: ExportedFile[];
  totalDocuments: number;
  totalBytes: number;
  durationMs: number;
  completed: boolean;
  format: TransferFormat;
  jsonMode?: JsonMode;
  skipped: { collection: string; reason: string }[];
}

const FORBIDDEN_POSIX = [
  '/bin',
  '/sbin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib64',
  '/proc',
  '/sys',
  '/usr',
  '/System',
  '/Library',
];

export function extensionFor(format: TransferFormat, layout: JsonLayout = 'array'): string {
  if (format === 'json') return layout === 'jsonl' ? '.jsonl' : '.json';
  return `.${format}`;
}

/**
 * Validates an export destination: absolute path, writable parent, not a system directory, not an
 * existing file unless overwrite is confirmed.
 */
export async function validateExportPath(
  target: string,
  options: { overwrite?: boolean; directory?: boolean } = {},
): Promise<string> {
  const cleaned = target.trim().replace(/^["']|["']$/g, '');
  if (!cleaned) throw new ValidationError('Output path is required');
  if (cleaned.includes('\0')) throw new ValidationError('Output path contains invalid characters');
  const resolved = path.resolve(cleaned);
  if (process.platform === 'win32') {
    const windir = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase();
    if (resolved.toLowerCase().startsWith(windir))
      throw new ValidationError('Refusing to write into the Windows system directory');
  } else {
    for (const dir of FORBIDDEN_POSIX) {
      if (resolved === dir || resolved.startsWith(`${dir}/`))
        throw new ValidationError(`Refusing to write into system directory ${dir}`);
    }
  }
  const parent = options.directory ? resolved : path.dirname(resolved);
  await fs.mkdir(parent, { recursive: true });
  await fs.access(parent, fsConstants.W_OK).catch(() => {
    throw new ValidationError(`Directory is not writable: ${parent}`);
  });
  if (!options.directory) {
    const existing = await fs.stat(resolved).catch(() => undefined);
    if (existing?.isDirectory()) throw new ValidationError(`${resolved} is a directory; provide a file name`);
    if (existing && !options.overwrite)
      throw new ValidationError(`${resolved} already exists. Choose another name or confirm overwrite.`);
  }
  return resolved;
}

function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters from file names
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

export class ExportManager {
  constructor(private readonly client: MongoClient) {}

  async run(options: ExportOptions): Promise<ExportSummary> {
    const started = Date.now();
    const summary: ExportSummary = {
      files: [],
      totalDocuments: 0,
      totalBytes: 0,
      durationMs: 0,
      completed: false,
      format: options.format,
      jsonMode: options.format === 'json' ? (options.jsonMode ?? 'relaxed') : undefined,
      skipped: [],
    };
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1)
      throw new ValidationError('Batch size must be a positive integer');
    if (options.collection) {
      const file = await validateExportPath(options.output, { overwrite: options.overwrite });
      const tracker = new ProgressTracker(options.onProgress, 'exporting');
      tracker.current = options.collection;
      summary.files.push(await this.exportCollection(options.collection, file, options, tracker));
    } else {
      const dir = await validateExportPath(options.output, { directory: true });
      const infos = await this.client.db(options.database).listCollections({}, { nameOnly: false }).toArray();
      const tracker = new ProgressTracker(options.onProgress, 'exporting');
      for (const info of infos) {
        const name = String(info.name);
        if (name.startsWith('system.')) {
          summary.skipped.push({ collection: name, reason: 'system collection' });
          continue;
        }
        if ((info as { type?: string }).type === 'view') {
          summary.skipped.push({ collection: name, reason: 'view (export its source collection instead)' });
          continue;
        }
        const file = path.join(
          dir,
          `${safeFileName(name)}${extensionFor(options.format, options.jsonLayout)}`,
        );
        const existing = await fs.stat(file).catch(() => undefined);
        if (existing && !options.overwrite) {
          summary.skipped.push({ collection: name, reason: `${file} exists` });
          continue;
        }
        tracker.current = name;
        summary.files.push(await this.exportCollection(name, file, { ...options, ids: undefined }, tracker));
      }
    }
    summary.totalDocuments = summary.files.reduce((a, f) => a + f.documents, 0);
    summary.totalBytes = summary.files.reduce((a, f) => a + f.bytes, 0);
    summary.durationMs = Date.now() - started;
    summary.completed = true;
    return summary;
  }

  private async exportCollection(
    collectionName: string,
    file: string,
    options: ExportOptions,
    tracker: ProgressTracker,
  ): Promise<ExportedFile> {
    const coll = this.client.db(options.database).collection(collectionName);
    const filter: Filter<Document> = options.ids
      ? ({ _id: { $in: options.ids } } as Filter<Document>)
      : (options.filter ?? {});
    let projection = options.projection;
    if (!projection && options.fields?.length && options.format !== 'csv') {
      projection = Object.fromEntries(options.fields.map((f) => [f, 1]));
    }
    // Estimated total for progress; exact counts would require a scan.
    if (!options.pipeline) {
      tracker.total =
        Object.keys(filter).length === 0
          ? await coll.estimatedDocumentCount({ maxTimeMS: 5000 }).catch(() => undefined)
          : await coll.countDocuments(filter, { maxTimeMS: 5000 }).catch(() => undefined);
      if (options.limit && tracker.total !== undefined)
        tracker.total = Math.min(tracker.total, options.limit);
      tracker.totalIsEstimate = Object.keys(filter).length === 0;
    }
    // Type fidelity per format: BSON streams raw server bytes; canonical JSON keeps Int32/Int64/
    // Double wrappers; relaxed JSON and CSV keep Int64 as Long (never rounded to a double).
    const fidelity =
      options.format === 'bson'
        ? { raw: true }
        : options.format === 'json' && options.jsonMode === 'canonical'
          ? { promoteValues: false }
          : { promoteLongs: false };
    const makeCursor = (forSample = false) =>
      options.pipeline
        ? coll.aggregate(options.pipeline, {
            batchSize: options.batchSize,
            maxTimeMS: options.maxTimeMS,
            allowDiskUse: false,
            ...(forSample ? {} : fidelity),
          })
        : coll.find(filter, {
            projection,
            sort: options.sort,
            limit: options.limit || undefined,
            batchSize: options.batchSize,
            maxTimeMS: options.maxTimeMS,
            ...(forSample ? {} : fidelity),
          });

    let fields = options.fields;
    if (options.format === 'csv' && !fields?.length) {
      // Infer columns from a bounded sample of the same query.
      const sampleCursor = makeCursor(true);
      const sample: Document[] = [];
      try {
        for await (const d of sampleCursor) {
          sample.push(d);
          if (sample.length >= 100) break;
        }
      } finally {
        await sampleCursor.close();
      }
      fields = inferCsvFields(sample);
    }

    // Write to a temporary file and rename on success, so a partial export is never mistaken for
    // a complete one.
    const tmp = `${file}.partial`;
    const out = createWriteStream(tmp, { mode: 0o644 });
    const writer =
      options.format === 'json'
        ? new JsonDocumentWriter(out, options.jsonLayout ?? 'array', options.jsonMode ?? 'relaxed')
        : options.format === 'csv'
          ? new CsvDocumentWriter(out, fields ?? ['_id'], options.csvDelimiter)
          : new BsonDocumentWriter(out);
    const cursor = makeCursor();
    let documents = 0;
    try {
      if (writer instanceof JsonDocumentWriter) await writer.begin();
      for await (const doc of cursor) {
        if (options.signal?.aborted) throw new CancelledError('Export cancelled');
        await writer.write(doc as Document);
        documents++;
        tracker.processed++;
        tracker.bytes = writer.bytes;
        tracker.tick();
      }
      await writer.end();
      out.end();
      await finished(out);
      await fs.rename(tmp, file);
    } catch (error) {
      out.destroy();
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await cursor.close().catch(() => undefined);
    }
    const stat = await fs.stat(file);
    tracker.tick(true);
    return { collection: collectionName, path: file, documents, bytes: stat.size };
  }
}

export const JSON_MODE_EXPLANATION = [
  'Relaxed Extended JSON (recommended): readable; ObjectId, Date, Decimal128, Binary keep {"$oid": ...} style wrappers.',
  'Numbers are plain JSON numbers (int/long/double are not distinguished); huge longs stay {"$numberLong"} — no precision loss.',
  'Canonical Extended JSON: fully lossless; every number is annotated ({"$numberInt": "1"}). Best for exact round trips.',
  'Plain JSON: ordinary JSON for other tools. ObjectIds and Dates become strings, Long/Decimal become numbers/strings —',
  'type information is LOST and re-importing will not restore the original BSON types.',
];
