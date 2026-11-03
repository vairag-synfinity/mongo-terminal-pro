import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ConnectionProfile } from '../connection/connection-types.js';
import { AppError, ValidationError } from '../core/error-handler.js';
import { timestampForFilename } from '../utils/formatting.js';
import { validateCollectionName, validateDatabaseName } from '../utils/validation.js';
import type { BackupHistory, BackupRecord } from './backup-history.js';
import {
  parseDumpCounts,
  verifyArchiveBackup,
  verifyDirectoryBackup,
  type BackupVerification,
} from './backup-validator.js';
import { requireTool, runProcess, toolVersion, writeToolConfig } from './database-tools.js';

export interface BackupOptions {
  /** Omit to back up all databases the user can read. */
  database?: string;
  collection?: string;
  gzip: boolean;
  /** Single-file archive instead of a directory tree. */
  archive: boolean;
  /** Parent directory; a timestamped sub-directory/file is created inside it. */
  outputDir: string;
  signal?: AbortSignal;
  onOutput?: (line: string) => void;
}

export interface BackupResult {
  success: boolean;
  path: string;
  exitCode: number | null;
  verification?: BackupVerification;
  record: BackupRecord;
  stderrTail: string;
}

function safeSegment(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'backup';
}

/**
 * Runs mongodump. A backup is only reported successful when mongodump exits with code 0 AND the
 * output passes verification.
 */
export class BackupManager {
  constructor(private readonly history: BackupHistory) {}

  buildTarget(profile: ConnectionProfile, options: BackupOptions): string {
    const parts = [timestampForFilename(), options.database ?? 'all-databases', options.collection].filter(
      Boolean,
    ) as string[];
    const base = path.join(
      path.resolve(options.outputDir),
      safeSegment(profile.name),
      parts.map(safeSegment).join('_'),
    );
    if (!options.archive) return base;
    return `${base}.archive${options.gzip ? '.gz' : ''}`;
  }

  buildArgs(configFile: string, target: string, options: BackupOptions): string[] {
    const args = ['--config', configFile];
    if (options.database) args.push('--db', options.database);
    if (options.collection) args.push('--collection', options.collection);
    if (options.gzip) args.push('--gzip');
    if (options.archive) args.push(`--archive=${target}`);
    else args.push('--out', target);
    return args;
  }

  async run(
    profile: ConnectionProfile,
    password: string | undefined,
    options: BackupOptions,
  ): Promise<BackupResult> {
    if (options.database) {
      const e = validateDatabaseName(options.database);
      if (e) throw new ValidationError(e);
    }
    if (options.collection) {
      if (!options.database) throw new ValidationError('A collection backup requires a database');
      const e = validateCollectionName(options.collection);
      if (e) throw new ValidationError(e);
    }
    const tool = requireTool('mongodump');
    const version = await toolVersion(tool);
    const target = this.buildTarget(profile, options);
    await fs.mkdir(options.archive ? path.dirname(target) : path.dirname(target), { recursive: true });
    const existing = await fs.stat(target).catch(() => undefined);
    if (existing) throw new AppError(`Backup target already exists: ${target}`, 'FILESYSTEM');

    const config = await writeToolConfig(profile, password);
    const started = Date.now();
    let output = '';
    try {
      const result = await runProcess(tool, this.buildArgs(config.file, target, options), {
        signal: options.signal,
        keepChars: 1024 * 1024,
        onLine: (line) => {
          output += `${line}\n`;
          options.onOutput?.(line);
        },
      });
      const cancelled = Boolean(options.signal?.aborted);
      let verification: BackupVerification | undefined;
      let status: BackupRecord['status'] = 'failed';
      if (result.code === 0 && !cancelled) {
        const counts = parseDumpCounts(output || result.stderr);
        verification = options.archive
          ? await verifyArchiveBackup(target, options.gzip, counts)
          : await verifyDirectoryBackup(target, counts);
        status = verification.ok ? 'success' : 'verification-failed';
      } else if (cancelled) {
        status = 'cancelled';
      }
      const errorLine = status === 'failed' ? lastErrorLine(result.stderr) : undefined;
      const record = await this.history.add({
        kind: 'backup',
        connectionId: profile.id,
        connectionName: profile.name,
        database: options.database,
        collection: options.collection,
        path: target,
        layout: options.archive ? 'archive' : 'directory',
        gzip: options.gzip,
        status,
        verified: verification?.ok ?? false,
        verificationSummary: verification?.summary,
        documents: verification?.totalDocuments,
        sizeBytes: verification?.sizeBytes,
        durationMs: Date.now() - started,
        toolVersion: version,
        error:
          errorLine ??
          (verification && !verification.ok ? verification.errors.slice(0, 3).join('; ') : undefined),
      });
      return {
        success: status === 'success',
        path: target,
        exitCode: result.code,
        verification,
        record,
        stderrTail: result.stderr.slice(-4000),
      };
    } finally {
      await config.cleanup();
    }
  }
}

export function lastErrorLine(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).filter((l) => l.trim());
  const failed = lines.reverse().find((l) => /Failed|error|unable/i.test(l));
  return failed ?? lines[0];
}
