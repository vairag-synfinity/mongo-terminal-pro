import { confirm, input, password as passwordPrompt } from '@inquirer/prompts';
import { Option, type Command } from 'commander';
import type { MongoClient } from 'mongodb';
import ora from 'ora';
import path from 'node:path';
import { needsPassword } from '../connection/connection-manager.js';
import type { ConnectionProfile } from '../connection/connection-types.js';
import type { Application } from '../core/application.js';
import { AppError } from '../core/error-handler.js';
import { Operations } from '../security/permission-manager.js';
import {
  CopyManager,
  listUserDatabases,
  type CopyDuplicates,
  type CopySummary,
} from '../transfer/copy-manager.js';
import { FolderImportManager, planFolderImport } from '../transfer/folder-import.js';
import { formatBytes, formatDuration, formatNumber } from '../utils/formatting.js';
import { oneOf, parseList, parsePositiveInt } from './arguments.js';
import { progressText, withConnection, type AppFactory } from './helpers.js';
import { c, fail, info, success, table, warn } from './output.js';
import { confirmOperation, enableCliWrites, isInteractive } from './session.js';

interface FolderOptions {
  db?: string;
  dir?: string;
  allDatabases?: boolean;
  mode: 'insert' | 'upsert';
  duplicates: 'abort' | 'skip';
  batchSize?: number;
  skipInvalid?: boolean;
  dryRun?: boolean;
  write?: boolean;
  confirm?: string;
  yes?: boolean;
}

/** `mtp import --dir <folder> [--db <db> | --all-databases]` */
export async function importFolderCommand(
  app: Application,
  cmd: Command,
  opts: FolderOptions,
): Promise<void> {
  const settings = await app.settings();
  const plan = await planFolderImport({
    dir: opts.dir as string,
    database: opts.db,
    allDatabases: opts.allDatabases,
  });
  console.log(
    table(
      ['File', 'Target', 'Size'],
      plan.map((p) => [
        path.relative(path.resolve(opts.dir as string), p.file),
        `${p.database}.${p.collection}`,
        formatBytes(p.size),
      ]),
    ),
  );
  await withConnection(app, cmd, async () => {
    if (!opts.dryRun) {
      await enableCliWrites(app, opts, 'Import');
      const dbs = [...new Set(plan.map((p) => p.database))];
      await confirmOperation(
        app,
        opts.mode === 'upsert' ? Operations.importUpsert : Operations.importInsert,
        `${plan.length} file(s) → ${dbs.join(', ')}`,
        opts,
      );
    }
    const spinner = isInteractive()
      ? ora({ text: 'Validating…', stream: process.stderr }).start()
      : undefined;
    let current = '';
    const result = await new FolderImportManager(app.connectionManager.getClient(), app.permissions).run({
      plan,
      mode: opts.mode,
      duplicates: opts.duplicates,
      batchSize: opts.batchSize ?? settings.importBatchSize,
      skipInvalid: opts.skipInvalid,
      dryRun: opts.dryRun,
      onFile: (e, i, phase) => {
        current = `${phase === 'validate' ? 'validating' : 'importing'} ${i + 1}/${plan.length} ${e.database}.${e.collection}`;
        if (spinner) spinner.text = current;
      },
      onProgress: (p) => {
        if (spinner) spinner.text = `${current} · ${progressText(p)}`;
      },
    });
    spinner?.stop();
    console.log(
      table(
        ['Target', 'Read', 'Invalid', 'Inserted', 'Upserted', 'Skipped dup.', 'Failed'],
        result.results.map(({ entry, summary: s }) => [
          `${entry.database}.${entry.collection}`,
          formatNumber(s.read),
          formatNumber(s.invalid),
          formatNumber(s.inserted),
          formatNumber(s.upserted),
          formatNumber(s.skippedDuplicates),
          formatNumber(s.failed),
        ]),
      ),
    );
    if (result.dryRun)
      success(
        `Dry run: ${result.invalid === 0 ? 'all files are valid' : `${result.invalid} invalid record(s)`}; nothing was written.`,
      );
    else if (result.aborted) fail(result.abortReason ?? 'Import stopped');
    else
      success(
        `Imported ${formatNumber(result.documents)} document(s) from ${plan.length} file(s) in ${formatDuration(result.durationMs)}`,
      );
    if (result.aborted || result.failed > 0 || (!result.dryRun && result.invalid > 0 && !opts.skipInvalid))
      process.exitCode = 2;
  });
}

interface CopyCliOptions {
  fromDb?: string;
  toDb?: string;
  allDatabases?: boolean;
  collections?: string[];
  toConnection?: string;
  drop?: boolean;
  duplicates: CopyDuplicates;
  indexes: boolean;
  views: boolean;
  batchSize?: number;
  write?: boolean;
  confirm?: string;
  yes?: boolean;
}

async function targetPassword(app: Application, profile: ConnectionProfile): Promise<string | undefined> {
  if (!profile.username || !needsPassword(profile)) return undefined;
  const stored = await app.connections.getPassword(profile.id).catch(() => undefined);
  if (stored !== undefined) return stored;
  if (process.env.MTP_TARGET_PASSWORD) return process.env.MTP_TARGET_PASSWORD;
  if (!isInteractive())
    throw new AppError(
      `Password required for target "${profile.name}"`,
      'AUTH',
      'Store it in the connection, or set MTP_TARGET_PASSWORD.',
    );
  return passwordPrompt({ message: `Password for ${profile.username}@${profile.name} (target):`, mask: '*' });
}

function printCopySummary(s: CopySummary): void {
  console.log(
    table(
      ['Collection', 'Type', 'Source docs', 'Inserted', 'Replaced', 'Skipped dup.', 'Indexes', 'Status'],
      s.collections.map((r) => [
        r.collection,
        r.type,
        r.type === 'view' ? '—' : formatNumber(r.sourceDocuments),
        formatNumber(r.inserted),
        formatNumber(r.replaced),
        formatNumber(r.skippedDuplicates),
        String(r.indexes),
        r.status === 'copied'
          ? c.green(r.message ? `copied (${r.message})` : 'copied')
          : r.status === 'skipped'
            ? c.yellow(`skipped: ${r.message}`)
            : c.red(`${r.status}: ${r.message ?? ''}`),
      ]),
    ),
  );
}

export function registerCopyCommand(program: Command, getApp: AppFactory): void {
  program
    .command('copy')
    .description(
      'copy collections from one database to another — same server or another connection (requires --write)',
    )
    .option('--from-db <db>', 'source database (on the active / --connection connection)')
    .option('--to-db <db>', 'target database (default: same name; required on the same connection)')
    .option('--all-databases', 'copy every user database (requires --to-connection)')
    .option('--collections <list>', 'only these collections (comma-separated)', parseList)
    .option('--to-connection <name>', 'saved connection to copy into (default: the same connection)')
    .option('--drop', 'DROP existing target collections first (destructive)')
    .addOption(
      new Option('--duplicates <mode>', 'abort | skip | replace documents whose _id already exists')
        .argParser(oneOf('duplicates', ['abort', 'skip', 'replace'] as const))
        .default('abort'),
    )
    .option('--no-indexes', 'do not copy indexes')
    .option('--no-views', 'do not copy views')
    .option('--batch-size <n>', 'documents per batch', parsePositiveInt('batch-size', 100_000))
    .option('--write', 'explicitly enable writing into the target')
    .option('--confirm <name>', 'confirm by name non-interactively (production / destructive)')
    .option('-y, --yes', 'skip confirmation prompts (non-production, non-destructive)')
    .addHelpText(
      'after',
      `
Examples:
  $ mtp copy -c Local --from-db shop --to-db shop_backup --write
  $ mtp copy -c Local --from-db shop --collections users,orders --to-connection Atlas --write
  $ mtp copy -c Local --all-databases --to-connection "New server" --write --duplicates skip`,
    )
    .action(async (opts: CopyCliOptions, cmd: Command) => {
      if (!opts.fromDb && !opts.allDatabases)
        throw new AppError('Pass --from-db <db> or --all-databases', 'VALIDATION');
      if (opts.allDatabases && !opts.toConnection)
        throw new AppError(
          '--all-databases copies to another server: pass --to-connection <name>',
          'VALIDATION',
        );
      if (opts.allDatabases && (opts.collections || opts.toDb))
        throw new AppError('--collections / --to-db cannot be combined with --all-databases', 'VALIDATION');
      if (!opts.write)
        throw new AppError(
          'Copy writes into the target database.',
          'READ_ONLY',
          'Re-run with --write to explicitly allow it.',
        );
      const app = await getApp();
      const settings = await app.settings();
      await withConnection(app, cmd, async () => {
        const source = app.connectionManager.activeProfile as ConnectionProfile;
        const target = opts.toConnection ? await app.connections.findByName(opts.toConnection) : source;
        if (!target) throw new AppError(`No saved connection named "${opts.toConnection}"`, 'NOT_FOUND');
        const sameConnection = target.id === source.id;
        if (sameConnection && !opts.toDb)
          throw new AppError('Copying on the same connection needs --to-db <new database>', 'VALIDATION');
        const op = opts.drop
          ? Operations.copyDrop
          : opts.duplicates === 'replace'
            ? Operations.copyReplace
            : Operations.copyData;
        const what = opts.allDatabases
          ? `all databases of "${source.name}"`
          : `${opts.fromDb}${opts.collections ? ` (${opts.collections.join(', ')})` : ''}`;
        const detail = `${what} → "${target.name}"${opts.allDatabases ? '' : ` › ${opts.toDb ?? opts.fromDb}`}`;

        if (sameConnection) {
          await enableCliWrites(app, { write: true, confirm: opts.confirm }, 'Copy');
          await confirmOperation(app, op, detail, opts);
        } else {
          const decision = app.permissions.checkTarget(op, target);
          if (!decision.allowed) throw new AppError(decision.reason ?? 'Not allowed', 'READ_ONLY');
          if (decision.confirmation === 'type-name') {
            let typed = opts.confirm;
            if (typed === undefined) {
              if (!isInteractive())
                throw new AppError(
                  `Copy into "${target.name}" needs confirmation`,
                  'CANCELLED',
                  `Pass --confirm "${target.name}".`,
                );
              typed = await input({
                message: `${c.red(`${op.name}: ${detail}`)}\nType "${target.name}" to confirm:`,
              });
            }
            if (typed !== target.name)
              throw new AppError(
                'Confirmation failed: the target connection name did not match',
                'CANCELLED',
              );
          } else if (!opts.yes) {
            if (!isInteractive())
              throw new AppError(
                'Copy needs confirmation',
                'CANCELLED',
                'Pass --yes to confirm in non-interactive mode.',
              );
            if (!(await confirm({ message: `${op.name}: ${detail}. Continue?`, default: false })))
              throw new AppError('Cancelled by user', 'CANCELLED');
          }
        }

        const sourceClient = app.connectionManager.getClient();
        let targetClient: MongoClient = sourceClient;
        if (!sameConnection) {
          const spinner = isInteractive()
            ? ora({ text: `Connecting to ${target.name}…`, stream: process.stderr }).start()
            : undefined;
          try {
            targetClient = await app.openSecondaryClient(target, await targetPassword(app, target));
            spinner?.stop();
          } catch (error) {
            spinner?.fail(`Could not connect to ${target.name}`);
            throw error;
          }
        }
        try {
          const databases = opts.allDatabases
            ? await listUserDatabases(sourceClient)
            : [opts.fromDb as string];
          if (databases.length === 0) {
            info('No user databases to copy.');
            return;
          }
          let failed = false;
          for (const db of databases) {
            const toDb = opts.allDatabases ? db : (opts.toDb ?? db);
            const spinner = isInteractive()
              ? ora({ text: `Copying ${db}…`, stream: process.stderr }).start()
              : undefined;
            const summary = await new CopyManager().run({
              source: { client: sourceClient, database: db, label: `${source.name} › ${db}` },
              target: { client: targetClient, database: toDb, label: `${target.name} › ${toDb}` },
              collections: opts.collections,
              includeViews: opts.views,
              copyIndexes: opts.indexes,
              dropTarget: opts.drop,
              duplicates: opts.duplicates,
              batchSize: opts.batchSize ?? settings.importBatchSize,
              onProgress: (p) => {
                if (spinner) spinner.text = `${db} → ${toDb} · ${progressText(p)}`;
              },
            });
            spinner?.stop();
            console.log(c.bold(`${summary.source}  →  ${summary.target}`));
            printCopySummary(summary);
            const bad = summary.collections.filter((r) => r.status === 'failed');
            if (summary.aborted) {
              fail(summary.abortReason ?? 'Copy stopped');
              failed = true;
              break;
            }
            if (bad.length) {
              warn(`${bad.length} collection(s) failed`);
              failed = true;
            } else
              success(
                `Copied ${formatNumber(summary.totalDocuments)} document(s) in ${formatDuration(summary.durationMs)}`,
              );
          }
          if (failed) process.exitCode = 2;
        } finally {
          if (!sameConnection) await targetClient.close().catch(() => undefined);
        }
      });
    });
}
