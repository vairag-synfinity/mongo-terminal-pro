import { promises as fs } from 'node:fs';
import type { MongoClient } from 'mongodb';
import type { ConnectionProfile } from '../connection/connection-types.js';
import { ValidationError } from '../core/error-handler.js';
import { Operations, type PermissionManager } from '../security/permission-manager.js';
import { validateDatabaseName } from '../utils/validation.js';
import type { BackupHistory, BackupRecord } from './backup-history.js';
import { lastErrorLine } from './backup-manager.js';
import { ARCHIVE_MAGIC, listDumpNamespaces } from './backup-validator.js';
import { requireTool, runProcess, toolVersion, writeToolConfig } from './database-tools.js';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

export interface BackupInspection {
  path: string;
  layout: 'directory' | 'archive';
  gzip: boolean;
  /** Namespaces in the backup (directory layout only; archives are listed during restore). */
  namespaces: { namespace: string; db: string; collection: string }[];
}

export interface CollisionReport {
  namespace: string;
  targetNamespace: string;
  exists: boolean;
  estimatedDocuments?: number;
}

export interface RestoreOptions {
  path: string;
  /** Drop each target collection before restoring (DESTRUCTIVE). */
  drop: boolean;
  /** Restore only these source databases/namespaces (mongorestore --nsInclude patterns). */
  nsInclude?: string[];
  /** Rename source database → target database. */
  fromDatabase?: string;
  toDatabase?: string;
  dryRun?: boolean;
  stopOnError?: boolean;
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
}

export interface RestoreResult {
  success: boolean;
  exitCode: number | null;
  restoredDocuments?: number;
  failedDocuments?: number;
  record: BackupRecord;
  stderrTail: string;
}

export async function inspectBackup(target: string): Promise<BackupInspection> {
  const stat = await fs.stat(target).catch(() => undefined);
  if (!stat) throw new ValidationError(`Backup not found: ${target}`);
  if (stat.isDirectory()) {
    const namespaces = (await listDumpNamespaces(target)).map(({ namespace, db, collection }) => ({
      namespace,
      db,
      collection,
    }));
    if (namespaces.length === 0)
      throw new ValidationError(
        'No .bson files found. Select the dump directory that contains database folders.',
      );
    const gzip = (await listDumpNamespaces(target)).some((n) => n.bsonFile.endsWith('.gz'));
    return { path: target, layout: 'directory', gzip, namespaces };
  }
  const handle = await fs.open(target, 'r');
  const head = Buffer.alloc(4);
  await handle.read(head, 0, 4, 0);
  await handle.close();
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  if (!gzip && head.readUInt32LE(0) !== ARCHIVE_MAGIC)
    throw new ValidationError('File is not a mongodump archive');
  if (gzip) {
    // Check the decompressed magic number without reading the whole file.
    const stream = createReadStream(target).pipe(createGunzip());
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      stream.destroy();
      if (buf.length < 4 || buf.readUInt32LE(0) !== ARCHIVE_MAGIC)
        throw new ValidationError('File is not a gzip-compressed mongodump archive');
      break;
    }
  }
  return { path: target, layout: 'archive', gzip, namespaces: [] };
}

export function mapNamespace(ns: { db: string; collection: string }, from?: string, to?: string): string {
  const db = from && to && ns.db === from ? to : ns.db;
  return `${db}.${ns.collection}`;
}

/** Checks which target collections already exist (namespace collisions) using metadata only. */
export async function checkCollisions(
  client: MongoClient,
  inspection: BackupInspection,
  options: Pick<RestoreOptions, 'fromDatabase' | 'toDatabase'>,
): Promise<CollisionReport[]> {
  const reports: CollisionReport[] = [];
  const byDb = new Map<string, Set<string>>();
  for (const ns of inspection.namespaces) {
    const target = mapNamespace(ns, options.fromDatabase, options.toDatabase);
    const db = target.slice(0, target.indexOf('.'));
    if (!byDb.has(db)) {
      const names = await client
        .db(db)
        .listCollections({}, { nameOnly: true })
        .toArray()
        .catch(() => []);
      byDb.set(db, new Set(names.map((n) => String(n.name))));
    }
    const exists = byDb.get(db)?.has(ns.collection) ?? false;
    let estimatedDocuments: number | undefined;
    if (exists)
      estimatedDocuments = await client
        .db(db)
        .collection(ns.collection)
        .estimatedDocumentCount({ maxTimeMS: 5000 })
        .catch(() => undefined);
    reports.push({ namespace: ns.namespace, targetNamespace: target, exists, estimatedDocuments });
  }
  return reports;
}

export class RestoreManager {
  constructor(
    private readonly history: BackupHistory,
    private readonly permissions: PermissionManager,
  ) {}

  buildArgs(configFile: string, inspection: BackupInspection, options: RestoreOptions): string[] {
    const args = ['--config', configFile];
    if (inspection.layout === 'archive') args.push(`--archive=${inspection.path}`);
    if (inspection.gzip) args.push('--gzip');
    if (options.drop) args.push('--drop');
    if (options.dryRun) args.push('--dryRun');
    if (options.stopOnError) args.push('--stopOnError');
    for (const ns of options.nsInclude ?? []) args.push('--nsInclude', ns);
    if (options.fromDatabase && options.toDatabase) {
      args.push('--nsFrom', `${options.fromDatabase}.*`, '--nsTo', `${options.toDatabase}.*`);
    }
    if (inspection.layout === 'directory') args.push(`--dir=${inspection.path}`);
    return args;
  }

  async run(
    profile: ConnectionProfile,
    password: string | undefined,
    options: RestoreOptions,
  ): Promise<RestoreResult> {
    if (options.toDatabase) {
      const e = validateDatabaseName(options.toDatabase);
      if (e) throw new ValidationError(e);
    }
    if (!options.dryRun) this.permissions.assert(options.drop ? Operations.restoreDrop : Operations.restore);
    const tool = requireTool('mongorestore');
    const version = await toolVersion(tool);
    const inspection = await inspectBackup(options.path);
    const config = await writeToolConfig(profile, password);
    const started = Date.now();
    let output = '';
    try {
      const result = await runProcess(tool, this.buildArgs(config.file, inspection, options), {
        signal: options.signal,
        keepChars: 1024 * 1024,
        onLine: (line) => {
          output += `${line}\n`;
          options.onOutput?.(line);
        },
      });
      const done = /(\d+) document\(s\) restored successfully\. (\d+) document\(s\) failed to restore/.exec(
        output || result.stderr,
      );
      const restoredDocuments = done ? Number(done[1]) : undefined;
      const failedDocuments = done ? Number(done[2]) : undefined;
      const cancelled = Boolean(options.signal?.aborted);
      const success = result.code === 0 && !cancelled && (failedDocuments ?? 0) === 0;
      const record = await this.history.add({
        kind: 'restore',
        connectionId: profile.id,
        connectionName: profile.name,
        database: options.toDatabase ?? options.fromDatabase,
        path: inspection.path,
        layout: inspection.layout,
        gzip: inspection.gzip,
        status: cancelled ? 'cancelled' : success ? 'success' : 'failed',
        verified: success,
        verificationSummary: done
          ? `${restoredDocuments} restored, ${failedDocuments} failed${options.dryRun ? ' (dry run)' : ''}`
          : options.dryRun
            ? 'dry run'
            : undefined,
        documents: restoredDocuments,
        durationMs: Date.now() - started,
        toolVersion: version,
        error: success
          ? undefined
          : (lastErrorLine(result.stderr) ??
            (failedDocuments ? `${failedDocuments} document(s) failed` : undefined)),
      });
      return {
        success,
        exitCode: result.code,
        restoredDocuments,
        failedDocuments,
        record,
        stderrTail: result.stderr.slice(-4000),
      };
    } finally {
      await config.cleanup();
    }
  }
}
