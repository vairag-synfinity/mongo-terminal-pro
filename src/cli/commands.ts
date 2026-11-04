import { checkbox, confirm, input, password as passwordPrompt, select } from '@inquirer/prompts';
import { Option, type Command } from 'commander';
import type { Document } from 'mongodb';
import ora from 'ora';
import path from 'node:path';
import { BackupManager } from '../backup/backup-manager.js';
import { detectTools, installInstructions } from '../backup/database-tools.js';
import { RestoreManager, checkCollisions, inspectBackup } from '../backup/restore-manager.js';
import { mongoexport, mongoimport } from '../backup/tools-transfer.js';
import { createConfigBackup, restoreConfigBackup } from '../config/configuration.js';
import { discoverCompassConnections, parseCompassExportFile } from '../connection/compass-discovery.js';
import { importDiscovered, markExisting } from '../connection/connection-discovery.js';
import type { ConnectionKind } from '../connection/connection-types.js';
import { validateDraft } from '../connection/connection-validator.js';
import {
  candidatesToConnections,
  collectFromEnvironment,
  collectFromProjectDirectory,
} from '../connection/env-discovery.js';
import { buildConnectionFromDraft, describeHosts, detectKind } from '../connection/manual-connection.js';
import { AppError, formatErrorLine } from '../core/error-handler.js';
import { Operations } from '../security/permission-manager.js';
import { maskConnectionString } from '../security/sensitive-data-filter.js';
import { ExportManager, JSON_MODE_EXPLANATION, extensionFor } from '../transfer/export-manager.js';
import { ImportManager, type ImportSummary } from '../transfer/import-manager.js';
import { detectFormat } from '../transfer/import-validator.js';
import type { JsonLayout, JsonMode } from '../transfer/json-handler.js';
import {
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatNumber,
  timestampForFilename,
} from '../utils/formatting.js';
import { getPlatformInfo } from '../utils/platform.js';
import { detectCapabilities } from '../utils/terminal.js';
import { oneOf, parseFormat, parseJsonObjectArg, parseList, parsePositiveInt } from './arguments.js';
import { importFolderCommand, registerCopyCommand } from './bulk-commands.js';
import { globals, progressText, withConnection, type AppFactory } from './helpers.js';
import { c, fail, info, printJson, success, sym, table, warn } from './output.js';
import {
  confirmKind,
  confirmOperation,
  enableCliWrites,
  isInteractive,
  resolveConnection,
} from './session.js';

export type { AppFactory } from './helpers.js';

export function registerCommands(
  program: Command,
  getApp: AppFactory,
  launchTui: (initial?: string) => Promise<void>,
): void {
  // ---------------------------------------------------------------------------------------------
  program
    .command('connect')
    .description('open the interactive connection manager')
    .action(async () => launchTui('connections'));

  // ---------------------------------------------------------------------------------------------
  const connections = program.command('connections').description('manage saved connections');

  connections
    .command('list', { isDefault: true })
    .description('list saved connections')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) => {
      const app = await getApp();
      const list = await app.connections.list();
      const defaultId = await app.connections.getDefaultId();
      if (opts.json) {
        printJson(
          list.map((p) => ({ ...p, uri: maskConnectionString(p.uri), isDefault: p.id === defaultId })),
        );
        return;
      }
      if (list.length === 0) {
        info(
          'No saved connections. Add one with "mongo-terminal connections add" or run "mongo-terminal" to use the interactive manager.',
        );
        return;
      }
      console.log(
        table(
          ['', 'Name', 'Type', 'Hosts', 'User', 'Flags', 'Last used'],
          list.map((p) => [
            p.id === defaultId ? c.green(sym().dot) : p.favorite ? c.yellow('*') : '',
            p.name,
            p.kind,
            describeHosts(p.uri),
            p.username ?? '',
            [
              p.production ? c.red('PROD') : '',
              p.readOnlyLocked ? 'locked-ro' : '',
              p.hasStoredPassword ? 'pw-saved' : '',
            ]
              .filter(Boolean)
              .join(' '),
            p.lastUsedAt ? formatDateTime(p.lastUsedAt) : '—',
          ]),
        ),
      );
    });

  connections
    .command('add')
    .description('add a connection interactively (passwords are prompted, never passed as arguments)')
    .option('--name <name>', 'connection name')
    .addOption(
      new Option('--uri <uri>', 'connection string WITHOUT password').argParser((v) => {
        if (/^mongodb(\+srv)?:\/\/[^@/]*:[^@/]+@/i.test(v))
          throw new AppError('Do not include the password in --uri; it will be prompted.', 'VALIDATION');
        return v;
      }),
    )
    .option('--production', 'mark as production (extra confirmations)')
    .option('--save-password', 'store the password in secure credential storage')
    .option('--no-test', 'skip the connection test')
    .action(
      async (opts: {
        name?: string;
        uri?: string;
        production?: boolean;
        savePassword?: boolean;
        test: boolean;
      }) => {
        const app = await getApp();
        if (!isInteractive() && (!opts.name || !opts.uri))
          throw new AppError('Non-interactive use requires --name and --uri', 'VALIDATION');
        const existing = (await app.connections.list()).map((p) => p.name);
        const name =
          opts.name ??
          (await input({
            message: 'Connection name:',
            validate: (v) =>
              validateDraft({ name: v, kind: 'local', uri: 'mongodb://localhost' }, existing).errors.name ??
              true,
          }));
        const uri =
          opts.uri ??
          (await input({
            message: 'Connection string (mongodb:// or mongodb+srv://, without password):',
            default: 'mongodb://localhost:27017',
          }));
        const normalized = buildConnectionFromDraft({ name, kind: 'self-hosted', uri });
        let username = normalized.username;
        if (!username && isInteractive())
          username = (await input({ message: 'Username (leave empty for none):' })) || undefined;
        let password: string | undefined;
        if (username) {
          password =
            process.env.MTP_PASSWORD ??
            (isInteractive() ? await passwordPrompt({ message: 'Password:', mask: '*' }) : undefined);
        }
        const production =
          opts.production ??
          (isInteractive()
            ? await confirm({ message: 'Is this a production database?', default: false })
            : false);
        const draft = { name, kind: 'self-hosted' as ConnectionKind, uri, username, password, production };
        const validation = validateDraft(draft, existing);
        for (const w of validation.warnings) warn(w);
        if (!validation.valid) throw new AppError(Object.values(validation.errors).join('; '), 'VALIDATION');
        if (opts.test) {
          const spinner = ora({ text: 'Testing connection…', stream: process.stderr }).start();
          const n = buildConnectionFromDraft(draft);
          const result = await app.connectionManager.test(
            {
              uri: n.uri,
              username: n.username,
              authSource: n.authSource,
              authMechanism: n.authMechanism,
              tls: { mode: 'default', allowInvalidCertificates: false, allowInvalidHostnames: false },
            },
            n.password,
          );
          if (result.ok)
            spinner.succeed(
              `Connected in ${result.latencyMs} ms — MongoDB ${result.server?.version} (${result.server?.topology})`,
            );
          else {
            spinner.fail('Connection test failed');
            fail(formatErrorLine(result.error));
            if (!isInteractive() || !(await confirm({ message: 'Save anyway?', default: false }))) return;
          }
        }
        const savePassword =
          Boolean(password) &&
          (opts.savePassword ??
            (isInteractive()
              ? await confirm({ message: 'Store the password in secure credential storage?', default: true })
              : false));
        const profile = await app.connections.create({ ...draft, kind: detectKind(uri) }, { savePassword });
        const backend = await app.credentials.backend();
        success(
          `Saved connection "${profile.name}"${savePassword ? ` (password stored in ${backend.description})` : ''}`,
        );
        if (app.credentials.fallbackReason && savePassword) warn(app.credentials.fallbackReason);
      },
    );

  connections
    .command('remove <name>')
    .alias('rm')
    .description('delete a saved connection and its stored password')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (name: string, opts: { yes?: boolean }) => {
      const app = await getApp();
      const profile = await app.connections.findByName(name);
      if (!profile) throw new AppError(`No connection named "${name}"`, 'NOT_FOUND');
      if (!opts.yes) {
        if (!isInteractive()) throw new AppError('Pass --yes to delete non-interactively', 'CANCELLED');
        if (!(await confirm({ message: `Delete connection "${profile.name}"?`, default: false }))) return;
      }
      await app.connections.delete(profile.id);
      success(`Deleted "${profile.name}"`);
    });

  connections
    .command('rename <name> <newName>')
    .description('rename a saved connection')
    .action(async (name: string, newName: string) => {
      const app = await getApp();
      const profile = await app.connections.findByName(name);
      if (!profile) throw new AppError(`No connection named "${name}"`, 'NOT_FOUND');
      await app.connections.rename(profile.id, newName);
      success(`Renamed to "${newName}"`);
    });

  connections
    .command('default <name>')
    .description('set the default connection')
    .action(async (name: string) => {
      const app = await getApp();
      const profile = await app.connections.findByName(name);
      if (!profile) throw new AppError(`No connection named "${name}"`, 'NOT_FOUND');
      await app.connections.setDefault(profile.id);
      success(`"${profile.name}" is now the default connection`);
    });

  connections
    .command('favorite <name>')
    .description('toggle favorite')
    .action(async (name: string) => {
      const app = await getApp();
      const profile = await app.connections.findByName(name);
      if (!profile) throw new AppError(`No connection named "${name}"`, 'NOT_FOUND');
      const updated = await app.connections.toggleFavorite(profile.id);
      success(`${updated.name} ${updated.favorite ? 'marked as favorite' : 'is no longer a favorite'}`);
    });

  connections
    .command('test [name]')
    .description('test a saved connection (default connection if omitted)')
    .action(async (name: string | undefined, _opts: unknown, cmd: Command) => {
      const app = await getApp();
      const resolved = await resolveConnection(app, name ?? globals(cmd).connection);
      const spinner = ora({ text: `Testing ${resolved.profile.name}…`, stream: process.stderr }).start();
      const result = await app.connectionManager.test(resolved.profile, resolved.password);
      if (result.ok)
        spinner.succeed(
          `${resolved.profile.name}: OK in ${result.latencyMs} ms — MongoDB ${result.server?.version}, ${result.server?.topology}`,
        );
      else {
        spinner.fail(`${resolved.profile.name}: failed`);
        throw result.error;
      }
    });

  connections
    .command('discover')
    .description('import connections from MongoDB Compass or project environment files')
    .option('--compass', 'discover MongoDB Compass saved connections')
    .option('--compass-export <file>', 'import a Compass "Export connections" file')
    .option('--env', 'discover MONGODB_URI-style variables in the current process environment')
    .option('--dir <directory>', 'read .env files from this project directory (not recursive)')
    .option('--all', 'import everything found without asking (non-interactive)')
    .option('--save-passwords', 'store passwords found in env files in secure credential storage')
    .action(
      async (opts: {
        compass?: boolean;
        compassExport?: string;
        env?: boolean;
        dir?: string;
        all?: boolean;
        savePasswords?: boolean;
      }) => {
        const app = await getApp();
        if (!opts.compass && !opts.env && !opts.dir && !opts.compassExport)
          throw new AppError(
            'Choose a source: --compass, --compass-export <file>, --env or --dir <path>',
            'VALIDATION',
          );
        const found = [];
        let secrets = new Map<string, string>();
        if (opts.compass) {
          const result = await discoverCompassConnections();
          if (!result.installed) warn('MongoDB Compass does not appear to be installed for this user.');
          for (const inst of result.installations)
            info(
              `Compass ${inst.variant}${inst.version ? ` ${inst.version}` : ''}: ${inst.connectionFiles} saved connection file(s)`,
            );
          for (const w of result.warnings) warn(w);
          found.push(...result.connections);
        }
        if (opts.compassExport) found.push(...(await parseCompassExportFile(opts.compassExport)));
        if (opts.env || opts.dir) {
          const candidates = opts.env ? collectFromEnvironment() : [];
          if (opts.dir) {
            const r = await collectFromProjectDirectory(opts.dir);
            info(`Read ${r.filesRead.length} env file(s) from ${path.resolve(opts.dir)}`);
            for (const w of r.warnings) warn(w);
            candidates.push(...r.candidates);
          }
          const converted = candidatesToConnections(candidates);
          found.push(...converted.connections);
          secrets = converted.secrets;
        }
        const marked = markExisting(found, await app.connections.list());
        if (marked.length === 0) {
          info('No connections found.');
          return;
        }
        console.log(
          table(
            ['Name', 'Source', 'Connection (masked)', 'Notes'],
            marked.map((d) => [
              d.name,
              d.source,
              d.displayUri,
              [d.alreadySaved ? 'already saved' : '', ...d.notes].filter(Boolean).join('; '),
            ]),
          ),
        );
        const candidates = marked.filter((d) => !d.alreadySaved);
        if (candidates.length === 0) {
          info('Everything found is already saved.');
          return;
        }
        let selected = candidates;
        if (!opts.all) {
          if (!isInteractive()) throw new AppError('Pass --all to import non-interactively', 'VALIDATION');
          const keys = await checkbox({
            message: 'Select connections to import:',
            choices: candidates.map((d) => ({
              name: `${d.name}  ${c.gray(d.displayUri)}`,
              value: d.key,
              checked: true,
            })),
          });
          selected = candidates.filter((d) => keys.includes(d.key));
        }
        const outcome = await importDiscovered(
          app.connections,
          selected,
          secrets,
          Boolean(opts.savePasswords),
        );
        success(`Imported ${outcome.imported.length} connection(s)`);
        if (outcome.needPassword.length > 0) {
          info(
            `Password needed for: ${outcome.needPassword.map((p) => p.name).join(', ')}. You will be asked when connecting.`,
          );
        }
      },
    );

  // ---------------------------------------------------------------------------------------------
  program
    .command('status')
    .description('show connection status and server information')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const app = await getApp();
      await withConnection(app, cmd, async () => {
        const server = app.connectionManager.serverInfo;
        const profile = app.connectionManager.activeProfile;
        const ping = await app.connectionManager.ping();
        const status = await app.db().statistics.serverStatus();
        const pool = app.db().statistics.poolConfiguration();
        if (opts.json) {
          printJson({ connection: profile?.name, ping, server, serverStatus: status.data ?? null, pool });
          return;
        }
        console.log(
          c.bold(`${c.green(sym().dot)} ${profile?.name}`) +
            c.gray(`  ${profile?.production ? c.red('PRODUCTION') : ''}`),
        );
        const rows: [string, string][] = [
          ['Status', c.green('Connected')],
          ['Hosts', server?.displayHosts ?? ''],
          ['Server version', server?.version ?? 'unknown'],
          [
            'Topology',
            `${server?.topology}${server?.replicaSetName ? ` (${server.replicaSetName})` : ''}${server?.isAtlas ? ' · MongoDB Atlas' : ''}`,
          ],
          ['Ping', `${ping} ms`],
          [
            'Pool',
            `maxPoolSize=${pool.maxPoolSize} minPoolSize=${pool.minPoolSize} maxIdleTimeMS=${pool.maxIdleTimeMS}`,
          ],
          ['Access mode', 'read-only (default)'],
        ];
        if (status.available && status.data) {
          rows.push(['Uptime', formatDuration((status.data.uptimeSeconds ?? 0) * 1000)]);
          if (status.data.connections)
            rows.push([
              'Server connections',
              `${status.data.connections.current} current / ${status.data.connections.available} available`,
            ]);
        } else rows.push(['serverStatus', c.gray(`unavailable (${status.reason})`)]);
        console.log(table(['Property', 'Value'], rows));
      });
    });

  program
    .command('databases')
    .alias('dbs')
    .description('list accessible databases')
    .option('--json', 'output JSON')
    .option('--no-stats', 'skip dbStats (faster on servers with many databases)')
    .action(async (opts: { json?: boolean; stats: boolean }, cmd: Command) => {
      const app = await getApp();
      await withConnection(app, cmd, async () => {
        const result = opts.stats
          ? await app.db().databases.listWithStats()
          : await app.db().databases.list();
        if (opts.json) {
          printJson(result);
          return;
        }
        if (result.warning) warn(result.warning);
        console.log(
          table(
            ['Database', 'Collections', 'Documents', 'Data size', 'Storage size', 'Indexes'],
            result.databases.map((d) => [
              d.name,
              d.stats ? formatNumber(d.stats.collections) : '—',
              d.stats ? formatCount(d.stats.objects, true) : '—',
              d.stats ? formatBytes(d.stats.dataSize) : '—',
              formatBytes(d.stats?.storageSize ?? d.sizeOnDisk),
              d.stats ? formatNumber(d.stats.indexes) : '—',
            ]),
            { colAligns: ['left', 'right', 'right', 'right', 'right', 'right'] },
          ),
        );
        console.log(c.gray('Document counts are metadata estimates (~).'));
      });
    });

  program
    .command('collections')
    .alias('colls')
    .description('list collections of a database')
    .requiredOption('--db <database>', 'database name')
    .option('--json', 'output JSON')
    .option('--search <text>', 'filter by name')
    .action(async (opts: { db: string; json?: boolean; search?: string }, cmd: Command) => {
      const app = await getApp();
      await withConnection(app, cmd, async () => {
        let list = await app.db().collections.list(opts.db, { withStats: true });
        if (opts.search)
          list = list.filter((col) => col.name.toLowerCase().includes(opts.search?.toLowerCase() ?? ''));
        if (opts.json) {
          printJson(list);
          return;
        }
        if (list.length === 0) {
          info(`No collections in ${opts.db} (or you lack permission to list them).`);
          return;
        }
        console.log(
          table(
            ['Collection', 'Type', 'Documents', 'Storage size', 'Indexes'],
            list.map((col) => [
              col.name,
              col.type,
              formatCount(col.count, col.countIsEstimate),
              formatBytes(col.storageSize),
              col.indexCount === undefined ? '—' : String(col.indexCount),
            ]),
            { colAligns: ['left', 'left', 'right', 'right', 'right'] },
          ),
        );
        console.log(c.gray('~ = estimated from collection metadata (no collection scan).'));
      });
    });

  program
    .command('query')
    .alias('find')
    .description('run a read-only find query and print documents as Extended JSON')
    .requiredOption('--db <database>', 'database name')
    .requiredOption('--collection <name>', 'collection name')
    .option('--filter <json>', 'filter document', '{}')
    .option('--projection <json>', 'projection document')
    .option('--sort <json>', 'sort document')
    .option('--limit <n>', 'maximum documents', parsePositiveInt('limit', 100_000), 20)
    .option('--skip <n>', 'documents to skip', (v) => Number(v), 0)
    .action(
      async (
        opts: {
          db: string;
          collection: string;
          filter: string;
          projection?: string;
          sort?: string;
          limit: number;
          skip: number;
        },
        cmd: Command,
      ) => {
        const app = await getApp();
        await withConnection(app, cmd, async () => {
          const settings = await app.settings();
          const { parseQuery } = await import('../database/query-manager.js');
          const { EJSON } = await import('../utils/bson.js');
          const limits = { resultLimit: settings.queryResultLimit, timeoutMs: settings.queryTimeoutMs };
          const q = parseQuery(
            {
              database: opts.db,
              collection: opts.collection,
              operation: 'find',
              filter: opts.filter,
              projection: opts.projection,
              sort: opts.sort,
              limit: opts.limit,
              skip: opts.skip,
            },
            limits,
          );
          for (const w of q.warnings) warn(w);
          const res = await app.db().queries.execute(q, limits);
          for (const d of res.documents ?? [])
            process.stdout.write(`${EJSON.stringify(d, undefined, 2, { relaxed: true })}\n`);
          console.error(
            c.gray(
              `${res.documents?.length ?? 0} document(s) in ${formatDuration(res.durationMs)}${res.truncated ? ' (more available — raise --limit)' : ''}`,
            ),
          );
        });
      },
    );

  // ---------------------------------------------------------------------------------------------
  program
    .command('export')
    .description('export a collection, query results, a whole database or every database (JSON, CSV, BSON)')
    .option('--db <database>', 'database name')
    .option('--all-databases', 'export every database: <out>/<database>/<collection>.<ext>')
    .option('--collection <name>', 'collection (omit to export every collection of the database)')
    .addOption(new Option('--format <format>', 'json | csv | bson').argParser(parseFormat).default('json'))
    .option('--out <path>', 'output file (collection) or directory (database)')
    .option('--filter <json>', 'filter document', parseJsonObjectArg('filter'))
    .option('--sort <json>', 'sort document', parseJsonObjectArg('sort'))
    .option('--fields <list>', 'comma-separated fields (CSV columns / projection)', parseList)
    .option('--limit <n>', 'maximum documents', parsePositiveInt('limit'))
    .addOption(
      new Option('--json-mode <mode>', 'relaxed | canonical | plain (see --explain-json)')
        .argParser(oneOf('json-mode', ['relaxed', 'canonical', 'plain'] as const))
        .default('relaxed'),
    )
    .addOption(
      new Option('--layout <layout>', 'array | jsonl')
        .argParser(oneOf('layout', ['array', 'jsonl'] as const))
        .default('array'),
    )
    .option('--batch-size <n>', 'cursor batch size', parsePositiveInt('batch-size', 100_000))
    .option('--overwrite', 'overwrite existing files')
    .addOption(
      new Option('--engine <engine>', 'builtin | tools (mongoexport)')
        .argParser(oneOf('engine', ['builtin', 'tools'] as const))
        .default('builtin'),
    )
    .option('--explain-json', 'explain Extended JSON vs plain JSON and exit')
    .action(async (opts: ExportCliOptions, cmd: Command) => {
      if (opts.explainJson) {
        console.log(JSON_MODE_EXPLANATION.join('\n'));
        return;
      }
      if (!opts.db && !opts.allDatabases)
        throw new AppError('Pass --db <database> or --all-databases', 'VALIDATION');
      if (opts.allDatabases && opts.collection)
        throw new AppError('--collection cannot be combined with --all-databases', 'VALIDATION');
      const app = await getApp();
      const settings = await app.settings();
      const baseDir = settings.defaultExportDir || app.paths.exportsDir;
      const output =
        opts.out ??
        (opts.allDatabases
          ? path.join(baseDir, `all-databases_${timestampForFilename()}`)
          : opts.collection
            ? path.join(
                baseDir,
                `${opts.db}.${opts.collection}_${timestampForFilename()}${extensionFor(opts.format, opts.layout)}`,
              )
            : path.join(baseDir, `${opts.db}_${timestampForFilename()}`));
      await withConnection(app, cmd, async () => {
        if (opts.engine === 'tools') {
          if (!opts.db || !opts.collection || opts.format === 'bson')
            throw new AppError('The tools engine exports one collection as json or csv', 'VALIDATION');
          const resolved = await resolveConnection(app, globals(cmd).connection);
          const { EJSON } = await import('../utils/bson.js');
          const result = await mongoexport(resolved.profile, resolved.password, {
            database: opts.db,
            collection: opts.collection,
            format: opts.format as 'json' | 'csv',
            output,
            fields: opts.fields,
            query: opts.filter ? EJSON.stringify(opts.filter, { relaxed: false }) : undefined,
            jsonArray: opts.layout === 'array',
            onOutput: (l) => console.error(c.gray(l)),
          });
          if (result.code !== 0) throw new AppError(`mongoexport failed (exit ${result.code})`, 'UNKNOWN');
          success(`Exported with mongoexport to ${output}`);
          return;
        }
        if (opts.format === 'json' && opts.jsonMode === 'plain')
          warn('Plain JSON loses BSON type information (ObjectId, Date, Long, Decimal128).');
        const spinner = isInteractive()
          ? ora({ text: 'Exporting…', stream: process.stderr }).start()
          : undefined;
        const manager = new ExportManager(app.connectionManager.getClient());
        const summary = await manager.run({
          database: opts.db ?? '',
          allDatabases: opts.allDatabases,
          collection: opts.collection,
          format: opts.format,
          output,
          overwrite: opts.overwrite,
          filter: opts.filter,
          sort: opts.sort,
          fields: opts.fields,
          limit: opts.limit,
          batchSize: opts.batchSize ?? settings.exportBatchSize,
          jsonMode: opts.jsonMode,
          jsonLayout: opts.layout,
          maxTimeMS: settings.queryTimeoutMs * 10,
          onProgress: (p) => {
            if (spinner) spinner.text = progressText(p);
          },
        });
        spinner?.stop();
        console.log(
          table(
            ['Collection', 'Documents', 'Size', 'File'],
            summary.files.map((f) => [
              f.database ? `${f.database}.${f.collection}` : f.collection,
              formatNumber(f.documents),
              formatBytes(f.bytes),
              f.path,
            ]),
          ),
        );
        for (const s of summary.skipped) warn(`Skipped ${s.collection}: ${s.reason}`);
        success(
          `Exported ${formatNumber(summary.totalDocuments)} document(s), ${formatBytes(summary.totalBytes)} in ${formatDuration(summary.durationMs)}`,
        );
      });
    });

  program
    .command('import')
    .description('import a JSON, JSONL, CSV or BSON file — or a whole folder — (requires --write)')
    .option('--db <database>', 'target database')
    .option('--collection <name>', 'target collection (created if missing)')
    .option('--file <path>', 'input file')
    .option('--dir <folder>', 'import every file of a folder (collection = file name) into --db')
    .option(
      '--all-databases',
      'with --dir: each sub-folder is a database (an "export --all-databases" folder)',
    )
    .addOption(
      new Option('--format <format>', 'json | csv | bson (default: from extension)').argParser(parseFormat),
    )
    .addOption(
      new Option('--mode <mode>', 'insert | upsert')
        .argParser(oneOf('mode', ['insert', 'upsert'] as const))
        .default('insert'),
    )
    .option('--upsert-fields <list>', 'match fields for upsert (default _id)', parseList)
    .addOption(
      new Option('--duplicates <mode>', 'abort | skip (insert mode)')
        .argParser(oneOf('duplicates', ['abort', 'skip'] as const))
        .default('abort'),
    )
    .option('--batch-size <n>', 'documents per batch', parsePositiveInt('batch-size', 100_000))
    .option('--unordered', 'unordered bulk writes (continue after errors)')
    .option('--skip-invalid', 'import valid records even if some are invalid')
    .option('--no-validate-first', 'skip the full validation pass before writing')
    .option('--dry-run', 'validate only; write nothing')
    .option('--delimiter <char>', 'CSV delimiter', ',')
    .option('--error-report <path>', 'write a JSONL error report')
    .option('--write', 'explicitly enable write access for this command')
    .option('--confirm <name>', 'confirm a production connection non-interactively')
    .option('-y, --yes', 'skip confirmation prompts (non-production)')
    .addOption(
      new Option('--engine <engine>', 'builtin | tools (mongoimport)')
        .argParser(oneOf('engine', ['builtin', 'tools'] as const))
        .default('builtin'),
    )
    .action(async (opts: ImportCliOptions, cmd: Command) => {
      if (opts.dir) return importFolderCommand(await getApp(), cmd, opts);
      if (!opts.db || !opts.collection || !opts.file)
        throw new AppError(
          'Pass --db, --collection and --file (or --dir <folder> to import a whole folder)',
          'VALIDATION',
        );
      const db = opts.db;
      const collection = opts.collection;
      const file = opts.file;
      const app = await getApp();
      const settings = await app.settings();
      await withConnection(app, cmd, async () => {
        if (!opts.dryRun) {
          await enableCliWrites(app, opts, 'Import');
          const op = opts.mode === 'upsert' ? Operations.importUpsert : Operations.importInsert;
          await confirmOperation(app, op, `${file} → ${db}.${collection}`, opts);
        }
        if (opts.engine === 'tools') {
          const format = opts.format ?? detectFormat(file);
          if (format !== 'json' && format !== 'csv')
            throw new AppError('The tools engine imports json or csv', 'VALIDATION');
          const resolved = await resolveConnection(app, globals(cmd).connection);
          const result = await mongoimport(resolved.profile, resolved.password, app.permissions, {
            database: db,
            collection: collection,
            format,
            file: file,
            mode: opts.mode,
            upsertFields: opts.upsertFields,
            jsonArray: format === 'json' && !/\.(jsonl|ndjson)$/i.test(file),
            stopOnError: !opts.unordered,
            onOutput: (l) => console.error(c.gray(l)),
          });
          if (result.code !== 0) throw new AppError(`mongoimport failed (exit ${result.code})`, 'UNKNOWN');
          success('Import finished with mongoimport');
          return;
        }
        const spinner = isInteractive()
          ? ora({ text: 'Reading…', stream: process.stderr }).start()
          : undefined;
        const manager = new ImportManager(app.connectionManager.getClient(), app.permissions);
        const summary = await manager.run({
          file: file,
          format: opts.format,
          database: db,
          collection: collection,
          mode: opts.mode,
          upsertKeys: opts.upsertFields,
          duplicates: opts.duplicates,
          batchSize: opts.batchSize ?? settings.importBatchSize,
          ordered: opts.unordered ? false : undefined,
          validateFirst: opts.validateFirst,
          skipInvalid: opts.skipInvalid,
          dryRun: opts.dryRun,
          csv: { delimiter: opts.delimiter },
          errorReportPath: opts.errorReport,
          onProgress: (p) => {
            if (spinner) spinner.text = progressText(p);
          },
        });
        spinner?.stop();
        printImportSummary(summary);
        if (summary.aborted || summary.failed > 0) process.exitCode = 2;
      });
    });

  registerCopyCommand(program, getApp);

  // ---------------------------------------------------------------------------------------------
  program
    .command('backup')
    .description('back up a database or collection with mongodump (verified)')
    .option('--db <database>', 'database (omit for all databases)')
    .option('--collection <name>', 'single collection')
    .option('--gzip', 'compress output')
    .option('--archive', 'write a single archive file')
    .option('--out <dir>', 'parent directory for backups')
    .action(
      async (
        opts: { db?: string; collection?: string; gzip?: boolean; archive?: boolean; out?: string },
        cmd: Command,
      ) => {
        const app = await getApp();
        const settings = await app.settings();
        const resolved = await resolveConnection(app, globals(cmd).connection);
        const manager = new BackupManager(app.backupHistory);
        const spinner = isInteractive()
          ? ora({ text: 'Running mongodump…', stream: process.stderr }).start()
          : undefined;
        const result = await manager.run(resolved.profile, resolved.password, {
          database: opts.db,
          collection: opts.collection,
          gzip: Boolean(opts.gzip),
          archive: Boolean(opts.archive),
          outputDir: opts.out ?? settings.defaultBackupDir ?? app.paths.backupsDir,
          onOutput: (line) => {
            if (spinner) spinner.text = line.replace(/^\S+\s+/, '').slice(0, 100);
            else console.error(c.gray(line));
          },
        });
        spinner?.stop();
        if (result.verification) {
          console.log(
            table(
              ['Namespace', 'Documents', 'Status'],
              result.verification.namespaces.map((n) => [
                n.namespace,
                formatNumber(n.documents),
                n.ok ? c.green('ok') : c.red(n.error ?? 'failed'),
              ]),
            ),
          );
        }
        if (result.success) {
          success(`Backup verified: ${result.verification?.summary}`);
          info(`Location: ${result.path} (${formatBytes(result.verification?.sizeBytes)})`);
        } else {
          fail(`Backup ${result.record.status}: ${result.record.error ?? 'see output above'}`);
          if (result.stderrTail) console.error(c.gray(result.stderrTail.split('\n').slice(-10).join('\n')));
          process.exitCode = 2;
        }
      },
    );

  program
    .command('restore')
    .description('restore a mongodump backup with mongorestore (requires --write)')
    .requiredOption('--path <path>', 'backup directory or archive file')
    .option('--from-db <db>', 'source database inside the backup (for renaming)')
    .option('--to-db <db>', 'restore into this database instead')
    .option('--ns-include <pattern...>', 'restore only matching namespaces (e.g. "mydb.users")')
    .option('--drop', 'DROP existing target collections before restoring (destructive)')
    .option('--dry-run', 'run mongorestore --dryRun (no writes)')
    .option('--write', 'explicitly enable write access for this command')
    .option('--confirm <name>', 'confirm a production connection non-interactively')
    .option('-y, --yes', 'skip confirmation prompts (non-production)')
    .action(
      async (
        opts: {
          path: string;
          fromDb?: string;
          toDb?: string;
          nsInclude?: string[];
          drop?: boolean;
          dryRun?: boolean;
          write?: boolean;
          confirm?: string;
          yes?: boolean;
        },
        cmd: Command,
      ) => {
        const app = await getApp();
        const inspection = await inspectBackup(path.resolve(opts.path));
        await withConnection(app, cmd, async () => {
          const resolved = await resolveConnection(app, globals(cmd).connection);
          if (inspection.layout === 'directory') {
            const collisions = await checkCollisions(app.connectionManager.getClient(), inspection, {
              fromDatabase: opts.fromDb,
              toDatabase: opts.toDb,
            });
            const existing = collisions.filter((x) => x.exists);
            console.log(
              table(
                ['Source', 'Target', 'Target exists'],
                collisions.map((x) => [
                  x.namespace,
                  x.targetNamespace,
                  x.exists ? c.yellow(`yes (~${formatNumber(x.estimatedDocuments)} docs)`) : 'no',
                ]),
              ),
            );
            if (existing.length > 0) {
              warn(
                opts.drop
                  ? `${existing.length} existing collection(s) will be DROPPED and replaced.`
                  : `${existing.length} collection(s) already exist; documents with duplicate _id will fail to restore (existing data is kept).`,
              );
            }
          } else info('Archive backup: namespaces are listed by mongorestore during the restore.');
          if (!opts.dryRun) {
            await enableCliWrites(app, opts, 'Restore');
            const op = opts.drop ? Operations.restoreDrop : Operations.restore;
            const decision = app.permissions.check(op);
            await confirmKind(
              app,
              decision.confirmation === 'none' ? 'confirm' : decision.confirmation,
              `${op.name} from ${inspection.path}`,
              opts,
            );
          }
          const manager = new RestoreManager(app.backupHistory, app.permissions);
          const result = await manager.run(resolved.profile, resolved.password, {
            path: inspection.path,
            drop: Boolean(opts.drop),
            nsInclude: opts.nsInclude,
            fromDatabase: opts.fromDb,
            toDatabase: opts.toDb,
            dryRun: opts.dryRun,
            onOutput: (l) => console.error(c.gray(l)),
          });
          if (result.success) success(`Restore finished: ${result.record.verificationSummary ?? 'ok'}`);
          else {
            fail(`Restore failed: ${result.record.error ?? `exit code ${result.exitCode}`}`);
            process.exitCode = 2;
          }
        });
      },
    );

  program
    .command('backups')
    .description('show backup and restore history')
    .option('--json', 'output JSON')
    .action(async (opts: { json?: boolean }) => {
      const app = await getApp();
      const records = await app.backupHistory.list();
      if (opts.json) {
        printJson(records);
        return;
      }
      if (records.length === 0) {
        info('No backups yet.');
        return;
      }
      console.log(
        table(
          ['When', 'Kind', 'Connection', 'Scope', 'Status', 'Docs', 'Size', 'Path'],
          records
            .slice(0, 50)
            .map((r) => [
              formatDateTime(r.createdAt),
              r.kind,
              r.connectionName,
              [r.database ?? 'all', r.collection].filter(Boolean).join('.'),
              r.status === 'success' ? c.green(r.status) : c.red(r.status),
              r.documents === undefined ? '—' : formatNumber(r.documents),
              formatBytes(r.sizeBytes),
              r.path,
            ]),
        ),
      );
    });

  program
    .command('tools')
    .description('check MongoDB Database Tools installation')
    .action(async () => {
      const tools = await detectTools();
      console.log(
        table(
          ['Tool', 'Status', 'Version', 'Path'],
          tools.map((t) => [
            t.name,
            t.path ? c.green('found') : c.red('missing'),
            t.version ?? '—',
            t.path ?? '—',
          ]),
        ),
      );
      if (tools.some((t) => !t.path)) console.log(installInstructions().join('\n'));
    });

  program
    .command('doctor')
    .description('diagnose terminal, platform, credential storage and tools')
    .action(async () => {
      const app = await getApp();
      const caps = detectCapabilities();
      const platform = getPlatformInfo();
      const backend = await app.credentials.backend();
      const tools = await detectTools();
      console.log(
        table(
          ['Check', 'Result'],
          [
            [
              'Platform',
              `${platform.platform} ${platform.release} (${platform.arch})${platform.isWSL ? ' · WSL' : ''}`,
            ],
            ['Node.js', process.version],
            ['Terminal', `${platform.terminalProgram ?? 'unknown'}${platform.isSSH ? ' · SSH session' : ''}`],
            ['TTY', String(caps.isTTY)],
            ['Size', `${caps.columns}x${caps.rows}`],
            ['Colours', ['none', '16', '256', 'truecolor'][caps.colorLevel] ?? 'unknown'],
            ['Unicode', caps.unicode ? 'yes' : 'no (ASCII fallback)'],
            ['Config directory', app.paths.configDir],
            ['Data directory', app.paths.dataDir],
            ['Credential storage', backend.description],
            ...(app.credentials.fallbackReason
              ? [['Note', app.credentials.fallbackReason] as [string, string]]
              : []),
            [
              'Database Tools',
              tools.every((t) => t.path)
                ? c.green(`all found (${tools[0]?.version ?? '?'})`)
                : c.yellow(
                    `missing: ${tools
                      .filter((t) => !t.path)
                      .map((t) => t.name)
                      .join(', ')}`,
                  ),
            ],
          ],
        ),
      );
    });

  // ---------------------------------------------------------------------------------------------
  const config = program.command('config').description('configuration backup, restore and location');
  config
    .command('path')
    .description('print configuration paths')
    .action(async () => {
      const app = await getApp();
      printJson(app.paths);
    });
  config
    .command('export <file>')
    .description('back up settings, connection profiles (no passwords) and saved queries')
    .action(async (file: string) => {
      const app = await getApp();
      const backup = await createConfigBackup(app.paths, path.resolve(file));
      success(
        `Configuration saved to ${path.resolve(file)} (${backup.connections.profiles.length} connections, no secrets)`,
      );
    });
  config
    .command('import <file>')
    .description('restore a configuration backup')
    .option('--merge', 'merge with existing connections instead of replacing them')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (file: string, opts: { merge?: boolean; yes?: boolean }) => {
      const app = await getApp();
      if (!opts.merge && !opts.yes) {
        if (!isInteractive()) throw new AppError('Pass --yes (replace) or --merge', 'CANCELLED');
        const choice = await select({
          message: 'How should existing connections be handled?',
          choices: [
            { name: 'Merge (keep existing)', value: 'merge' },
            { name: 'Replace', value: 'replace' },
            { name: 'Cancel', value: 'cancel' },
          ],
        });
        if (choice === 'cancel') return;
        opts.merge = choice === 'merge';
      }
      const result = await restoreConfigBackup(app.paths, path.resolve(file), { merge: Boolean(opts.merge) });
      success(
        `Restored ${result.connections} connection(s), ${result.savedQueries} saved quer(ies). Passwords must be re-entered.`,
      );
    });
}

interface ExportCliOptions {
  db?: string;
  allDatabases?: boolean;
  collection?: string;
  format: 'json' | 'csv' | 'bson';
  out?: string;
  filter?: Document;
  sort?: Document;
  fields?: string[];
  limit?: number;
  jsonMode: JsonMode;
  layout: JsonLayout;
  batchSize?: number;
  overwrite?: boolean;
  engine: 'builtin' | 'tools';
  explainJson?: boolean;
}

interface ImportCliOptions {
  db?: string;
  collection?: string;
  file?: string;
  dir?: string;
  allDatabases?: boolean;
  format?: 'json' | 'csv' | 'bson';
  mode: 'insert' | 'upsert';
  upsertFields?: string[];
  duplicates: 'abort' | 'skip';
  batchSize?: number;
  unordered?: boolean;
  skipInvalid?: boolean;
  validateFirst: boolean;
  dryRun?: boolean;
  delimiter: string;
  errorReport?: string;
  write?: boolean;
  confirm?: string;
  yes?: boolean;
  engine: 'builtin' | 'tools';
}

function printImportSummary(s: ImportSummary): void {
  const rows: [string, string][] = [
    ['File', `${s.file} (${s.format})`],
    ['Target', `${s.database}.${s.collection} (${s.mode})`],
    ['Records read', formatNumber(s.read)],
    ['Valid / invalid', `${formatNumber(s.valid)} / ${formatNumber(s.invalid)}`],
  ];
  if (!s.dryRun) {
    rows.push(['Inserted', formatNumber(s.inserted)]);
    if (s.mode === 'upsert')
      rows.push(['Upserted / matched / modified', `${s.upserted} / ${s.matched} / ${s.modified}`]);
    rows.push(['Skipped duplicates', formatNumber(s.skippedDuplicates)], ['Failed', formatNumber(s.failed)]);
  }
  rows.push(['Duration', formatDuration(s.durationMs)]);
  console.log(table(['Import summary', ''], rows));
  for (const e of s.errors.slice(0, 10))
    warn(`#${e.index + 1}${e.location ? ` (${e.location})` : ''}: ${e.message}`);
  if (s.errorCount > 10)
    warn(
      `… ${s.errorCount - 10} more error(s)${s.errorReportPath ? ` — see ${s.errorReportPath}` : ' (use --error-report <file>)'}`,
    );
  if (s.aborted && (!s.dryRun || s.abortReason?.includes('not readable')))
    fail(s.abortReason ?? 'Import aborted');
  else if (s.dryRun)
    success(
      `Dry run complete: ${s.invalid === 0 ? 'file is valid' : `${s.invalid} invalid record(s)`}; nothing was written.`,
    );
  else
    success(
      `Import complete: ${formatNumber(s.inserted + s.upserted)} new, ${formatNumber(s.modified)} modified.`,
    );
}
