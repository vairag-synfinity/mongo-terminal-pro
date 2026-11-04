import {
  MongoBulkWriteError,
  type AnyBulkWriteOperation,
  type Collection,
  type Document,
  type MongoClient,
} from 'mongodb';
import { CancelledError, ValidationError } from '../core/error-handler.js';
import { isSystemDatabase } from '../database/database-manager.js';
import { validateCollectionName, validateDatabaseName } from '../utils/validation.js';
import { ProgressTracker, type ProgressCallback } from './transfer-progress.js';

/**
 * Copies collections between databases — on the same server or between two connections.
 *
 * - Streams documents with bounded batches (never loads a collection into memory) and keeps exact
 *   BSON types (`promoteValues: false`).
 * - Recreates collection options (capped, validators, collation, time series), views and indexes.
 * - Existing target data is never overwritten silently: duplicates abort (default) or are skipped;
 *   replacing documents or dropping target collections must be chosen explicitly.
 * Permission checks happen in the caller (the target may be another connection).
 */

export type CopyDuplicates = 'abort' | 'skip' | 'replace';

export interface CopyEndpoint {
  client: MongoClient;
  database: string;
  /** Label for messages, e.g. "Local › shop". */
  label?: string;
}

export interface CopyOptions {
  source: CopyEndpoint;
  target: CopyEndpoint;
  /** Collections to copy; default: every non-system collection and view. */
  collections?: string[];
  includeViews?: boolean;
  copyIndexes?: boolean;
  /** Drop each target collection before copying (DESTRUCTIVE). */
  dropTarget?: boolean;
  duplicates?: CopyDuplicates;
  batchSize: number;
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
}

export interface CollectionCopyResult {
  collection: string;
  type: 'collection' | 'view' | 'timeseries';
  sourceDocuments: number;
  inserted: number;
  skippedDuplicates: number;
  replaced: number;
  failed: number;
  indexes: number;
  status: 'copied' | 'skipped' | 'failed' | 'cancelled';
  message?: string;
}

export interface CopySummary {
  source: string;
  target: string;
  collections: CollectionCopyResult[];
  totalDocuments: number;
  durationMs: number;
  aborted: boolean;
  abortReason?: string;
}

interface SourceCollection {
  name: string;
  type: 'collection' | 'view' | 'timeseries';
  options: Document;
}

const COPYABLE_OPTIONS = [
  'capped',
  'size',
  'max',
  'validator',
  'validationLevel',
  'validationAction',
  'collation',
  'timeseries',
  'expireAfterSeconds',
  'clusteredIndex',
  'changeStreamPreAndPostImages',
];

export function sameDatabase(a: CopyEndpoint, b: CopyEndpoint): boolean {
  return a.client === b.client && a.database === b.database;
}

export async function listSourceCollections(
  client: MongoClient,
  database: string,
): Promise<SourceCollection[]> {
  const infos = await client
    .db(database)
    .listCollections({}, { nameOnly: false, authorizedCollections: true })
    .toArray();
  return infos
    .filter((i) => !String(i.name).startsWith('system.'))
    .map((i) => {
      const raw = i as { name: string; type?: string; options?: Document };
      const type = raw.type === 'view' ? 'view' : raw.type === 'timeseries' ? 'timeseries' : 'collection';
      return { name: raw.name, type, options: raw.options ?? {} } as SourceCollection;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export class CopyManager {
  async run(options: CopyOptions): Promise<CopySummary> {
    const { source, target } = options;
    for (const db of [source.database, target.database]) {
      const e = validateDatabaseName(db);
      if (e) throw new ValidationError(e);
    }
    if (sameDatabase(source, target))
      throw new ValidationError(
        'Source and target are the same database; choose another target database or connection.',
      );
    if (isSystemDatabase(target.database))
      throw new ValidationError(`Refusing to copy into system database "${target.database}"`);
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1)
      throw new ValidationError('Batch size must be a positive integer');

    const started = Date.now();
    const all = await listSourceCollections(source.client, source.database);
    const wanted = options.collections?.length
      ? all.filter((c) => options.collections?.includes(c.name))
      : all;
    const missing = (options.collections ?? []).filter((n) => !all.some((c) => c.name === n));
    if (missing.length) throw new ValidationError(`Not found in ${source.database}: ${missing.join(', ')}`);
    for (const c of wanted) {
      const e = validateCollectionName(c.name);
      if (e) throw new ValidationError(`${c.name}: ${e}`);
    }
    const summary: CopySummary = {
      source: source.label ?? source.database,
      target: target.label ?? target.database,
      collections: [],
      totalDocuments: 0,
      durationMs: 0,
      aborted: false,
    };
    const tracker = new ProgressTracker(options.onProgress, 'writing');
    // Estimated total for the progress bar (metadata only).
    let total = 0;
    for (const c of wanted) {
      if (c.type !== 'view')
        total += await source.client
          .db(source.database)
          .collection(c.name)
          .estimatedDocumentCount({ maxTimeMS: 5000 })
          .catch(() => 0);
    }
    tracker.total = total;
    tracker.totalIsEstimate = true;

    const targetDb = target.client.db(target.database);
    const existing = new Set(
      (await targetDb.listCollections({}, { nameOnly: true }).toArray()).map((c) => String(c.name)),
    );
    // Real collections first, views last (views may depend on them).
    const ordered = [...wanted.filter((c) => c.type !== 'view'), ...wanted.filter((c) => c.type === 'view')];

    for (const c of ordered) {
      if (options.signal?.aborted) {
        summary.aborted = true;
        summary.abortReason = 'Cancelled by user';
        break;
      }
      tracker.current = c.name;
      const result: CollectionCopyResult = {
        collection: c.name,
        type: c.type,
        sourceDocuments: 0,
        inserted: 0,
        skippedDuplicates: 0,
        replaced: 0,
        failed: 0,
        indexes: 0,
        status: 'copied',
      };
      summary.collections.push(result);
      try {
        if (c.type === 'view') {
          if (options.includeViews === false) {
            result.status = 'skipped';
            result.message = 'views excluded';
            continue;
          }
          if (existing.has(c.name)) {
            if (!options.dropTarget) {
              result.status = 'skipped';
              result.message = 'view already exists in target';
              continue;
            }
            await targetDb.collection(c.name).drop();
          }
          await targetDb.createCollection(c.name, {
            viewOn: c.options.viewOn as string,
            pipeline: c.options.pipeline as Document[],
            collation: c.options.collation as never,
          });
          result.message = 'view recreated';
          continue;
        }
        if (existing.has(c.name) && options.dropTarget) {
          await targetDb.collection(c.name).drop();
          existing.delete(c.name);
        }
        if (!existing.has(c.name)) {
          const createOptions: Document = {};
          for (const k of COPYABLE_OPTIONS) if (c.options[k] !== undefined) createOptions[k] = c.options[k];
          await targetDb.createCollection(c.name, createOptions);
          existing.add(c.name);
        }
        const ok = await this.copyDocuments(
          source.client.db(source.database).collection(c.name),
          targetDb.collection(c.name),
          options,
          result,
          tracker,
        );
        if (options.copyIndexes !== false)
          result.indexes = await this.copyIndexes(
            source.client.db(source.database).collection(c.name),
            targetDb.collection(c.name),
            result,
          );
        summary.totalDocuments += result.inserted + result.replaced;
        if (!ok) {
          summary.aborted = true;
          summary.abortReason = result.message;
          break;
        }
      } catch (error) {
        if (error instanceof CancelledError) {
          result.status = 'cancelled';
          summary.aborted = true;
          summary.abortReason = 'Cancelled by user';
          break;
        }
        result.status = 'failed';
        result.message = (error as Error).message;
      }
    }
    tracker.finish();
    summary.durationMs = Date.now() - started;
    return summary;
  }

  private async copyDocuments(
    from: Collection,
    to: Collection,
    options: CopyOptions,
    result: CollectionCopyResult,
    tracker: ProgressTracker,
  ): Promise<boolean> {
    const duplicates = options.duplicates ?? 'abort';
    const cursor = from.find({}, { batchSize: options.batchSize, promoteValues: false, sort: { _id: 1 } });
    let batch: Document[] = [];
    const flush = async (): Promise<boolean> => {
      if (batch.length === 0) return true;
      const docs = batch;
      batch = [];
      if (duplicates === 'replace') {
        const ops: AnyBulkWriteOperation<Document>[] = docs.map((d) => ({
          replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
        }));
        try {
          const r = await to.bulkWrite(ops, { ordered: false });
          result.inserted += r.upsertedCount;
          result.replaced += r.matchedCount;
        } catch (error) {
          if (!(error instanceof MongoBulkWriteError)) throw error;
          result.inserted += error.result.upsertedCount;
          result.replaced += error.result.matchedCount;
          result.failed += Array.isArray(error.writeErrors) ? error.writeErrors.length : 1;
        }
      } else {
        try {
          const r = await to.insertMany(docs, { ordered: duplicates === 'abort' });
          result.inserted += r.insertedCount;
        } catch (error) {
          if (!(error instanceof MongoBulkWriteError)) throw error;
          result.inserted += error.result.insertedCount;
          const errs = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
          const dups = errs.filter((e) => e.code === 11000).length;
          if (duplicates === 'skip') {
            result.skippedDuplicates += dups;
            result.failed += errs.length - dups;
          } else {
            result.failed += errs.length;
            result.status = 'failed';
            result.message = dups
              ? `Stopped at a duplicate _id in ${to.collectionName} (existing documents were not modified). Use "skip" or "replace" for duplicates.`
              : `Write error: ${errs[0]?.errmsg ?? 'unknown'}`;
            return false;
          }
        }
      }
      tracker.processed += docs.length;
      tracker.tick();
      return true;
    };
    try {
      for await (const doc of cursor) {
        if (options.signal?.aborted) throw new CancelledError();
        result.sourceDocuments++;
        batch.push(doc);
        if (batch.length >= options.batchSize && !(await flush())) return false;
      }
      return await flush();
    } finally {
      await cursor.close().catch(() => undefined);
    }
  }

  private async copyIndexes(from: Collection, to: Collection, result: CollectionCopyResult): Promise<number> {
    const indexes = await from.listIndexes().toArray();
    let created = 0;
    for (const idx of indexes) {
      if (idx.name === '_id_') continue;
      const { key, v: _v, ns: _ns, ...opts } = idx as Document;
      try {
        await to.createIndex(key as Document, opts);
        created++;
      } catch (error) {
        const msg = (error as Error).message;
        // An identical index already existing is fine; anything else is reported.
        if (!/already exists|IndexOptionsConflict|equivalent index/i.test(msg)) {
          result.message = `${result.message ? `${result.message}; ` : ''}index ${String(idx.name)}: ${msg}`;
        }
      }
    }
    return created;
  }
}

/** User databases of a server (system databases admin/local/config excluded). */
export async function listUserDatabases(client: MongoClient): Promise<string[]> {
  const res = await client
    .db('admin')
    .command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true });
  return (res.databases as { name: string }[])
    .map((d) => d.name)
    .filter((n) => !isSystemDatabase(n))
    .sort();
}
