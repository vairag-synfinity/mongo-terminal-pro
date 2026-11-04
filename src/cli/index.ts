import { Command, Option } from 'commander';
import { readFileSync } from 'node:fs';
import { Application } from '../core/application.js';
import { formatErrorLine } from '../core/error-handler.js';
import { redactText } from '../security/sensitive-data-filter.js';
import { registerTerminalRestore, restoreTerminal } from '../utils/terminal.js';
import { registerCommands } from './commands.js';
import { c, setColor } from './output.js';

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

interface RootOptions {
  connection?: string;
  configDir?: string;
  color: boolean;
  ascii?: boolean;
  unicode?: boolean;
  theme?: 'dark' | 'light';
  mouse?: boolean;
  log: boolean;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('mongo-terminal')
    .description(
      'Mongo Terminal Pro — interactive MongoDB management in your terminal.\nRun without a command to open the interactive dashboard. Alias: mtp\nMade by Vairag Kakadiya',
    )
    .version(packageVersion(), '-v, --version')
    .option('-c, --connection <name>', 'saved connection to use (name or id)')
    .option('--config-dir <path>', 'use an alternative configuration directory')
    .option('--no-color', 'disable colours (also honours NO_COLOR)')
    .option('--ascii', 'use ASCII symbols instead of Unicode')
    .option('--unicode', 'force Unicode symbols')
    .addOption(new Option('--theme <theme>', 'dark | light').choices(['dark', 'light']))
    .option('--mouse', 'enable mouse wheel scrolling in the dashboard')
    .option('--no-log', 'disable the log file')
    .showHelpAfterError('(add --help for usage)')
    .configureHelp({ sortSubcommands: false })
    .addHelpText(
      'after',
      `
Examples:
  $ mongo-terminal                               open the interactive dashboard
  $ mtp connections add                          add a connection (password is prompted)
  $ mtp connections discover --compass           import MongoDB Compass connections
  $ mtp databases -c local                       list databases
  $ mtp collections --db shop                    list collections
  $ mtp export --db shop --collection users --format json
  $ mtp import --db shop --collection users --file users.json --write
  $ mtp backup --db shop --gzip

Credentials are never accepted as command-line arguments. Use saved connections,
MTP_URI / MTP_PASSWORD environment variables, or the interactive prompt.`,
    );

  let appPromise: Promise<Application> | undefined;
  const getApp = () => {
    if (!appPromise) {
      const opts = program.opts<RootOptions>();
      if (opts.configDir) process.env.MTP_CONFIG_DIR = opts.configDir;
      appPromise = Application.create({ logging: opts.log });
    }
    return appPromise;
  };

  const launchTui = async (initialScreen?: string) => {
    const opts = program.opts<RootOptions>();
    const app = await getApp();
    const { runTui } = await import('../ui/run.js');
    await runTui(app, {
      initialScreen,
      connectionName: opts.connection,
      overrides: {
        color: opts.color === false ? 'no-color' : undefined,
        unicode: opts.ascii ? 'ascii' : opts.unicode ? 'unicode' : undefined,
        theme: opts.theme,
        mouse: opts.mouse,
      },
    });
  };

  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals<RootOptions>();
    if (opts.color === false || process.env.NO_COLOR) setColor(false);
  });

  program.action(async () => launchTui());
  registerCommands(program, getApp, launchTui);

  cleanup = async () => {
    if (appPromise) await (await appPromise).shutdown().catch(() => undefined);
  };
  return program;
}

let cleanup: () => Promise<void> = async () => undefined;

export async function main(argv: string[] = process.argv): Promise<void> {
  registerTerminalRestore();
  process.on('uncaughtException', (error) => {
    restoreTerminal();
    console.error(c.red(redactText(formatErrorLine(error))));
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    restoreTerminal();
    console.error(c.red(redactText(formatErrorLine(error))));
    process.exit(1);
  });
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    restoreTerminal();
    const name = (error as { name?: string }).name;
    if (name === 'ExitPromptError' || name === 'AbortPromptError') {
      console.error(c.gray('Cancelled.'));
      process.exitCode = 130;
      return;
    }
    console.error(c.red(formatErrorLine(error)));
    for (const d of (error as { details?: string[] }).details ?? [])
      console.error(c.red(`  - ${redactText(d)}`));
    process.exitCode = 1;
  } finally {
    // Always close the MongoDB client (also after errors) so the process can exit.
    await cleanup();
  }
}
