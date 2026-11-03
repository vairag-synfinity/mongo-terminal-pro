import type { ConnectionProfile } from '../connection/connection-types.js';
import { ValidationError } from '../core/error-handler.js';
import { Operations, type PermissionManager } from '../security/permission-manager.js';
import { validateCollectionName, validateDatabaseName } from '../utils/validation.js';
import { requireTool, runProcess, writeToolConfig, type ProcessResult } from './database-tools.js';

/**
 * Optional engine that delegates import/export to the official mongoexport / mongoimport tools
 * (useful when matching existing scripts exactly). The built-in streaming engine is the default.
 */

export interface ToolsExportOptions {
  database: string;
  collection: string;
  format: 'json' | 'csv';
  output: string;
  fields?: string[];
  /** Extended JSON filter string, passed via --query (not a shell). */
  query?: string;
  jsonArray?: boolean;
  onOutput?: (line: string) => void;
  signal?: AbortSignal;
}

export interface ToolsImportOptions {
  database: string;
  collection: string;
  format: 'json' | 'csv';
  file: string;
  mode: 'insert' | 'upsert';
  upsertFields?: string[];
  jsonArray?: boolean;
  headerline?: boolean;
  stopOnError?: boolean;
  onOutput?: (line: string) => void;
  signal?: AbortSignal;
}

function check(database: string, collection: string): void {
  const e = validateDatabaseName(database) ?? validateCollectionName(collection);
  if (e) throw new ValidationError(e);
}

export async function mongoexport(
  profile: ConnectionProfile,
  password: string | undefined,
  o: ToolsExportOptions,
): Promise<ProcessResult> {
  check(o.database, o.collection);
  if (o.format === 'csv' && !o.fields?.length)
    throw new ValidationError('mongoexport requires --fields for CSV output');
  const tool = requireTool('mongoexport');
  const cfg = await writeToolConfig(profile, password);
  try {
    const args = [
      '--config',
      cfg.file,
      '--db',
      o.database,
      '--collection',
      o.collection,
      '--type',
      o.format,
      '--out',
      o.output,
    ];
    if (o.fields?.length) args.push('--fields', o.fields.join(','));
    if (o.query) args.push('--query', o.query);
    if (o.jsonArray && o.format === 'json') args.push('--jsonArray');
    return await runProcess(tool, args, { onLine: (l) => o.onOutput?.(l), signal: o.signal });
  } finally {
    await cfg.cleanup();
  }
}

export async function mongoimport(
  profile: ConnectionProfile,
  password: string | undefined,
  permissions: PermissionManager,
  o: ToolsImportOptions,
): Promise<ProcessResult> {
  check(o.database, o.collection);
  permissions.assert(o.mode === 'upsert' ? Operations.importUpsert : Operations.importInsert);
  const tool = requireTool('mongoimport');
  const cfg = await writeToolConfig(profile, password);
  try {
    const args = [
      '--config',
      cfg.file,
      '--db',
      o.database,
      '--collection',
      o.collection,
      '--type',
      o.format,
      '--file',
      o.file,
      '--mode',
      o.mode,
    ];
    if (o.mode === 'upsert' && o.upsertFields?.length) args.push('--upsertFields', o.upsertFields.join(','));
    if (o.jsonArray) args.push('--jsonArray');
    if (o.headerline || o.format === 'csv') args.push('--headerline');
    if (o.stopOnError) args.push('--stopOnError');
    return await runProcess(tool, args, { onLine: (l) => o.onOutput?.(l), signal: o.signal });
  } finally {
    await cfg.cleanup();
  }
}
