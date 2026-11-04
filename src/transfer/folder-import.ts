import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MongoClient } from 'mongodb';
import { CancelledError, ValidationError } from '../core/error-handler.js';
import { isSystemDatabase } from '../database/database-manager.js';
import { Operations, type PermissionManager } from '../security/permission-manager.js';
import { validateCollectionName, validateDatabaseName } from '../utils/validation.js';
import {
  ImportManager,
  type DuplicateHandling,
  type ImportMode,
  type ImportSummary,
} from './import-manager.js';
import { detectFormat, type TransferFormat } from './import-validator.js';
import type { ProgressCallback } from './transfer-progress.js';

/**
 * Imports a whole folder:
 *  - one database:   <dir>/<collection>.json|jsonl|csv|bson[.gz]  → <database>.<collection>
 *  - all databases:  <dir>/<database>/<collection>.<ext>          (the layout written by
 *                    "export all databases"; mongodump folders work too)
 * Every file is validated before anything is written.
 */

export interface FolderPlanEntry {
  file: string;
  format: TransferFormat;
  database: string;
  collection: string;
  size: number;
}

const DATA_EXT = /\.(json|jsonl|ndjson|csv|tsv|bson)(\.gz)?$/i;

export function collectionNameFromFile(file: string): string {
  return path.basename(file).replace(DATA_EXT, '');
}

async function filesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        e.isFile() &&
        DATA_EXT.test(e.name) &&
        !/\.metadata\.json(\.gz)?$/i.test(e.name) &&
        !e.name.endsWith('.partial'),
    )
    .map((e) => path.join(dir, e.name))
    .sort();
}

export async function planFolderImport(options: {
  dir: string;
  database?: string;
  allDatabases?: boolean;
}): Promise<FolderPlanEntry[]> {
  const dir = path.resolve(options.dir.trim().replace(/^["']|["']$/g, ''));
  const stat = await fs.stat(dir).catch(() => undefined);
  if (!stat?.isDirectory()) throw new ValidationError(`Not a folder: ${dir}`);
  const groups: { database: string; dir: string }[] = [];
  if (options.allDatabases) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory() && !isSystemDatabase(e.name))
        groups.push({ database: e.name, dir: path.join(dir, e.name) });
    }
    if (groups.length === 0)
      throw new ValidationError(
        'No database folders found (expected <folder>/<database>/<collection>.json …)',
      );
  } else {
    if (!options.database?.trim()) throw new ValidationError('Choose the target database');
    groups.push({ database: options.database.trim(), dir });
  }
  const plan: FolderPlanEntry[] = [];
  const problems: string[] = [];
  for (const g of groups) {
    const dbError = validateDatabaseName(g.database);
    if (dbError) problems.push(`${g.database}: ${dbError}`);
    const seen = new Map<string, string>();
    for (const file of await filesIn(g.dir)) {
      const collection = collectionNameFromFile(file);
      const err = validateCollectionName(collection);
      if (err) {
        problems.push(`${path.basename(file)}: ${err}`);
        continue;
      }
      const clash = seen.get(collection);
      if (clash)
        problems.push(
          `${path.basename(file)} and ${path.basename(clash)} would both import into ${g.database}.${collection}`,
        );
      seen.set(collection, file);
      plan.push({
        file,
        format: detectFormat(file) as TransferFormat,
        database: g.database,
        collection,
        size: (await fs.stat(file)).size,
      });
    }
  }
  if (problems.length) throw new ValidationError('The folder cannot be imported as is', problems);
  if (plan.length === 0)
    throw new ValidationError('No .json, .jsonl, .csv or .bson files found in the folder');
  return plan;
}

export interface FolderImportOptions {
  plan: FolderPlanEntry[];
  mode: ImportMode;
  duplicates?: DuplicateHandling;
  batchSize: number;
  skipInvalid?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  /** Called when a file starts (phase "validate" or "import"). */
  onFile?(entry: FolderPlanEntry, index: number, phase: 'validate' | 'import'): void;
}

export interface FolderImportSummary {
  results: { entry: FolderPlanEntry; summary: ImportSummary }[];
  documents: number;
  invalid: number;
  failed: number;
  aborted: boolean;
  abortReason?: string;
  durationMs: number;
  dryRun: boolean;
}

export class FolderImportManager {
  constructor(
    private readonly client: MongoClient,
    private readonly permissions: PermissionManager,
  ) {}

  async run(options: FolderImportOptions): Promise<FolderImportSummary> {
    const started = Date.now();
    if (!options.dryRun)
      this.permissions.assert(options.mode === 'upsert' ? Operations.importUpsert : Operations.importInsert);
    const importer = new ImportManager(this.client, this.permissions);
    const out: FolderImportSummary = {
      results: [],
      documents: 0,
      invalid: 0,
      failed: 0,
      aborted: false,
      durationMs: 0,
      dryRun: Boolean(options.dryRun),
    };
    const base = {
      mode: options.mode,
      duplicates: options.duplicates,
      batchSize: options.batchSize,
      signal: options.signal,
      onProgress: options.onProgress,
    };

    // Phase 1: validate every file before writing anything.
    const validation: ImportSummary[] = [];
    for (const [i, entry] of options.plan.entries()) {
      if (options.signal?.aborted) throw new CancelledError('Import cancelled');
      options.onFile?.(entry, i, 'validate');
      validation.push(
        await importer.run({
          ...base,
          file: entry.file,
          format: entry.format,
          database: entry.database,
          collection: entry.collection,
          dryRun: true,
        }),
      );
    }
    out.invalid = validation.reduce((a, s) => a + s.invalid, 0);
    if (options.dryRun || (out.invalid > 0 && !options.skipInvalid)) {
      out.results = options.plan.map((entry, i) => ({ entry, summary: validation[i] as ImportSummary }));
      if (!options.dryRun) {
        out.aborted = true;
        out.abortReason = `${out.invalid} invalid record(s) in ${validation.filter((v) => v.invalid > 0).length} file(s); nothing was written. Fix the files or enable "skip invalid records".`;
      }
      out.durationMs = Date.now() - started;
      return out;
    }

    // Phase 2: write, file by file.
    for (const [i, entry] of options.plan.entries()) {
      if (options.signal?.aborted) {
        out.aborted = true;
        out.abortReason = 'Cancelled by user';
        break;
      }
      options.onFile?.(entry, i, 'import');
      // Create the collection up front so empty files still produce (empty) collections.
      await this.client
        .db(entry.database)
        .createCollection(entry.collection)
        .catch((e: { codeName?: string }) => {
          if (e.codeName !== 'NamespaceExists') throw e;
        });
      const summary = await importer.run({
        ...base,
        file: entry.file,
        format: entry.format,
        database: entry.database,
        collection: entry.collection,
        validateFirst: false,
        skipInvalid: options.skipInvalid,
      });
      out.results.push({ entry, summary });
      out.documents += summary.inserted + summary.upserted;
      out.failed += summary.failed;
      if (summary.aborted) {
        out.aborted = true;
        out.abortReason = `${entry.database}.${entry.collection}: ${summary.abortReason ?? 'stopped'}`;
        break;
      }
    }
    out.durationMs = Date.now() - started;
    return out;
  }
}
