import type { AnyBulkWriteOperation, Document, MongoClient } from 'mongodb';
import { MongoBulkWriteError } from 'mongodb';
import { createReadStream, promises as fs } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { CancelledError, ValidationError } from '../core/error-handler.js';
import { Operations, type PermissionManager } from '../security/permission-manager.js';
import { validateCollectionName, validateDatabaseName } from '../utils/validation.js';
import { readBsonDocuments } from './bson-handler.js';
import {
  csvRecordToDocument,
  readCsvRows,
  type CsvFieldMapping,
  type CsvReadOptions,
} from './csv-handler.js';
import {
  checkImportFile,
  getDotted,
  validateImportDocument,
  type ImportIssue,
  type TransferFormat,
} from './import-validator.js';
import { readJsonDocuments } from './json-handler.js';
import { ProgressTracker, type ProgressCallback } from './transfer-progress.js';

export type ImportMode = 'insert' | 'upsert';
export type DuplicateHandling = 'abort' | 'skip';

export interface ImportOptions {
  file: string;
  format?: TransferFormat;
  database: string;
  collection: string;
  /** insert: never touches existing documents. upsert: replaces documents matching `upsertKeys`. */
  mode: ImportMode;
  upsertKeys?: string[];
  /** insert mode only: abort on the first duplicate key, or skip duplicates and continue. */
  duplicates?: DuplicateHandling;
  batchSize: number;
  ordered?: boolean;
  /** Validate the whole file before writing anything (default true). */
  validateFirst?: boolean;
  /** Import valid documents even if some are invalid (explicit opt-in). */
  skipInvalid?: boolean;
  /** Validate only; write nothing. */
  dryRun?: boolean;
  csv?: CsvReadOptions & { mapping?: CsvFieldMapping[] };
  errorReportPath?: string;
  maxErrorsInSummary?: number;
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}

export interface ImportSummary {
  file: string;
  format: TransferFormat;
  database: string;
  collection: string;
  mode: ImportMode;
  read: number;
  valid: number;
  invalid: number;
  inserted: number;
  upserted: number;
  matched: number;
  modified: number;
  skippedDuplicates: number;
  failed: number;
  durationMs: number;
  dryRun: boolean;
  aborted: boolean;
  abortReason?: string;
  errors: ImportIssue[];
  errorCount: number;
  errorReportPath?: string;
}

interface SourceRecord {
  index: number;
  location?: string;
  document?: Document;
  error?: string;
}

function countingStream(tracker: ProgressTracker): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      tracker.bytes += chunk.length;
      cb(null, chunk);
    },
  });
}

async function* readSource(
  file: string,
  format: TransferFormat,
  gzip: boolean,
  tracker: ProgressTracker,
  csv: ImportOptions['csv'],
): AsyncGenerator<SourceRecord> {
  let stream: Readable = createReadStream(file, { highWaterMark: 256 * 1024 }).pipe(countingStream(tracker));
  if (gzip) stream = stream.pipe(createGunzip());
  try {
    if (format === 'json') {
      const lines = /\.(jsonl|ndjson)(\.gz)?$/i.test(file);
      for await (const d of readJsonDocuments(stream, { lines })) {
        yield { index: d.index, location: `line ${d.line}`, document: d.document, error: d.error };
      }
    } else if (format === 'bson') {
      for await (const d of readBsonDocuments(stream)) {
        yield { index: d.index, location: `byte ${d.offset}`, document: d.document, error: d.error };
      }
    } else {
      for await (const row of readCsvRows(stream, csv)) {
        try {
          yield {
            index: row.index,
            location: `line ${row.line}`,
            document: csvRecordToDocument(row.record, csv?.mapping, csv),
          };
        } catch (error) {
          yield { index: row.index, location: `line ${row.line}`, error: (error as Error).message };
        }
      }
    }
  } finally {
    stream.destroy();
  }
}

/**
 * Streams a JSON/CSV/BSON file into a collection in bounded batches.
 *
 * Safety:
 *  - insert mode never overwrites; duplicates either abort the import or are skipped and counted.
 *  - upsert mode replaces matching documents only when explicitly chosen (destructive permission).
 *  - By default the entire file is validated first; nothing is written if any record is invalid
 *    unless `skipInvalid` is set.
 */
export class ImportManager {
  constructor(
    private readonly client: MongoClient,
    private readonly permissions: PermissionManager,
  ) {}

  async run(options: ImportOptions): Promise<ImportSummary> {
    const dbError = validateDatabaseName(options.database);
    if (dbError) throw new ValidationError(dbError);
    const collError = validateCollectionName(options.collection);
    if (collError) throw new ValidationError(collError);
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100_000) {
      throw new ValidationError('Batch size must be between 1 and 100000');
    }
    const upsertKeys =
      options.mode === 'upsert' ? (options.upsertKeys?.length ? options.upsertKeys : ['_id']) : [];
    if (!options.dryRun) {
      this.permissions.assert(options.mode === 'upsert' ? Operations.importUpsert : Operations.importInsert);
    }
    const check = await checkImportFile(options.file, options.format);
    const started = Date.now();
    const maxErrors = options.maxErrorsInSummary ?? 100;
    const summary: ImportSummary = {
      file: check.path,
      format: check.format,
      database: options.database,
      collection: options.collection,
      mode: options.mode,
      read: 0,
      valid: 0,
      invalid: 0,
      inserted: 0,
      upserted: 0,
      matched: 0,
      modified: 0,
      skippedDuplicates: 0,
      failed: 0,
      durationMs: 0,
      dryRun: Boolean(options.dryRun),
      aborted: false,
      errors: [],
      errorCount: 0,
    };
    const report = options.errorReportPath ? await fs.open(options.errorReportPath, 'w', 0o600) : undefined;
    const recordIssue = async (issue: ImportIssue) => {
      summary.errorCount++;
      if (summary.errors.length < maxErrors) summary.errors.push(issue);
      if (report) await report.write(`${JSON.stringify(issue)}\n`);
    };

    try {
      const validateFirst = options.validateFirst !== false || options.dryRun;
      if (validateFirst) {
        const tracker = new ProgressTracker(options.onProgress, 'validating', undefined, check.size);
        try {
          for await (const rec of readSource(check.path, check.format, check.gzip, tracker, options.csv)) {
            if (options.signal?.aborted) throw new CancelledError('Import cancelled during validation');
            summary.read++;
            tracker.processed++;
            const issues = rec.error
              ? [{ index: rec.index, location: rec.location, message: rec.error }]
              : validateImportDocument(rec.document as Document, rec.index, rec.location, upsertKeys);
            if (issues.length > 0) {
              summary.invalid++;
              for (const i of issues) await recordIssue(i);
            } else summary.valid++;
            tracker.tick();
          }
        } catch (error) {
          if (error instanceof CancelledError) throw error;
          // Structural errors (truncated file, broken JSON nesting, corrupt BSON) stop reading.
          await recordIssue({ index: summary.read, message: (error as Error).message });
          summary.invalid++;
          summary.aborted = true;
          summary.abortReason = `The file is not readable past record ${summary.read}: ${(error as Error).message}. Nothing was written.`;
          return this.finish(summary, started, options.errorReportPath);
        }
        tracker.tick(true);
        if (options.dryRun) return this.finish(summary, started, options.errorReportPath);
        if (summary.invalid > 0 && !options.skipInvalid) {
          summary.aborted = true;
          summary.abortReason = `${summary.invalid} invalid record(s) found during validation; nothing was written. Fix the file or enable "skip invalid records".`;
          return this.finish(summary, started, options.errorReportPath);
        }
        if (summary.valid === 0) {
          summary.aborted = true;
          summary.abortReason = 'The file contains no importable documents.';
          return this.finish(summary, started, options.errorReportPath);
        }
      }

      // Write pass.
      const collection = this.client.db(options.database).collection(options.collection);
      const tracker = new ProgressTracker(
        options.onProgress,
        'writing',
        validateFirst ? summary.valid : undefined,
        check.size,
      );
      const ordered = options.ordered ?? options.duplicates !== 'skip';
      let batch: Document[] = [];
      const writeOnly = !validateFirst;
      if (writeOnly) {
        summary.read = 0;
      }
      const flush = async (): Promise<boolean> => {
        if (batch.length === 0) return true;
        const docs = batch;
        batch = [];
        const ok =
          options.mode === 'upsert'
            ? await this.flushUpserts(collection, docs, upsertKeys, ordered, summary, recordIssue)
            : await this.flushInserts(
                collection,
                docs,
                ordered,
                options.duplicates ?? 'abort',
                summary,
                recordIssue,
              );
        tracker.processed += docs.length;
        tracker.tick();
        return ok;
      };
      for await (const rec of readSource(check.path, check.format, check.gzip, tracker, options.csv)) {
        if (options.signal?.aborted) {
          summary.aborted = true;
          summary.abortReason = 'Cancelled by user';
          break;
        }
        if (writeOnly) summary.read++;
        if (rec.error || !rec.document) {
          if (writeOnly) {
            summary.invalid++;
            await recordIssue({
              index: rec.index,
              location: rec.location,
              message: rec.error ?? 'Unreadable record',
            });
          }
          continue;
        }
        const issues = validateImportDocument(rec.document, rec.index, rec.location, upsertKeys);
        if (issues.length > 0) {
          if (writeOnly) {
            summary.invalid++;
            for (const i of issues) await recordIssue(i);
          }
          continue;
        }
        if (writeOnly) summary.valid++;
        batch.push(rec.document);
        if (batch.length >= options.batchSize) {
          if (!(await flush())) break;
        }
      }
      if (!summary.aborted) await flush();
      tracker.finish();
      return this.finish(summary, started, options.errorReportPath);
    } finally {
      await report?.close();
    }
  }

  private finish(summary: ImportSummary, started: number, reportPath?: string): ImportSummary {
    summary.durationMs = Date.now() - started;
    if (reportPath && summary.errorCount > 0) summary.errorReportPath = reportPath;
    return summary;
  }

  private async flushInserts(
    collection: ReturnType<ReturnType<MongoClient['db']>['collection']>,
    docs: Document[],
    ordered: boolean,
    duplicates: DuplicateHandling,
    summary: ImportSummary,
    recordIssue: (i: ImportIssue) => Promise<void>,
  ): Promise<boolean> {
    try {
      const res = await collection.insertMany(docs, { ordered });
      summary.inserted += res.insertedCount;
      return true;
    } catch (error) {
      if (!(error instanceof MongoBulkWriteError)) throw error;
      summary.inserted += error.result.insertedCount;
      const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
      let fatal = false;
      for (const we of writeErrors) {
        const isDup = we.code === 11000;
        if (isDup && duplicates === 'skip') {
          summary.skippedDuplicates++;
          continue;
        }
        summary.failed++;
        await recordIssue({
          index: we.index,
          message: `${isDup ? 'Duplicate key' : 'Write error'}: ${we.errmsg ?? we.code}`,
        });
        if (isDup || ordered) fatal = true;
      }
      if (fatal && (duplicates === 'abort' || ordered)) {
        summary.aborted = true;
        summary.abortReason =
          duplicates === 'abort'
            ? 'Stopped at a duplicate key (no existing documents were modified). Choose "skip duplicates" to continue past them.'
            : 'Stopped at a write error.';
        return false;
      }
      return true;
    }
  }

  private async flushUpserts(
    collection: ReturnType<ReturnType<MongoClient['db']>['collection']>,
    docs: Document[],
    keys: string[],
    ordered: boolean,
    summary: ImportSummary,
    recordIssue: (i: ImportIssue) => Promise<void>,
  ): Promise<boolean> {
    const ops: AnyBulkWriteOperation<Document>[] = docs.map((doc) => {
      const filter: Document = {};
      for (const k of keys) filter[k] = getDotted(doc, k);
      const replacement = { ...doc };
      if (!keys.includes('_id') && replacement._id === undefined) delete replacement._id;
      return { replaceOne: { filter, replacement, upsert: true } };
    });
    try {
      const res = await collection.bulkWrite(ops, { ordered });
      summary.upserted += res.upsertedCount;
      summary.matched += res.matchedCount;
      summary.modified += res.modifiedCount;
      return true;
    } catch (error) {
      if (!(error instanceof MongoBulkWriteError)) throw error;
      summary.upserted += error.result.upsertedCount;
      summary.matched += error.result.matchedCount;
      summary.modified += error.result.modifiedCount;
      const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
      for (const we of writeErrors) {
        summary.failed++;
        await recordIssue({ index: we.index, message: `Write error: ${we.errmsg ?? we.code}` });
      }
      if (ordered) {
        summary.aborted = true;
        summary.abortReason = 'Stopped at a write error.';
        return false;
      }
      return true;
    }
  }
}

export interface ImportPreview {
  file: string;
  size: number;
  format: TransferFormat;
  gzip: boolean;
  documents: Document[];
  errors: string[];
  csv?: { headers: string[]; rows: Record<string, string>[] };
}

/** Reads only the first `count` records of a file for preview (streaming; never loads the whole file). */
export async function previewImportFile(
  file: string,
  format: TransferFormat | undefined,
  count = 5,
  csv?: CsvReadOptions & { mapping?: CsvFieldMapping[] },
): Promise<ImportPreview> {
  const check = await checkImportFile(file, format);
  const preview: ImportPreview = {
    file: check.path,
    size: check.size,
    format: check.format,
    gzip: check.gzip,
    documents: [],
    errors: [],
  };
  const tracker = new ProgressTracker(undefined, 'validating');
  if (check.format === 'csv') {
    let stream: Readable = createReadStream(check.path);
    if (check.gzip) stream = stream.pipe(createGunzip());
    const rows: Record<string, string>[] = [];
    let headers: string[] = [];
    try {
      for await (const row of readCsvRows(stream, csv)) {
        if (headers.length === 0) headers = Object.keys(row.record);
        rows.push(row.record);
        try {
          preview.documents.push(csvRecordToDocument(row.record, csv?.mapping, csv));
        } catch (error) {
          preview.errors.push(`Row ${row.index + 1}: ${(error as Error).message}`);
        }
        if (rows.length >= count) break;
      }
    } finally {
      stream.destroy();
    }
    preview.csv = { headers, rows };
    return preview;
  }
  for await (const rec of readSource(check.path, check.format, check.gzip, tracker, csv)) {
    if (rec.document) preview.documents.push(rec.document);
    if (rec.error) preview.errors.push(`Record ${rec.index + 1} (${rec.location}): ${rec.error}`);
    if (preview.documents.length + preview.errors.length >= count) break;
  }
  return preview;
}
