import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'mongo-terminal-pro';

export interface PathContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Resolves the OS-standard per-user configuration directory:
 *   Windows: %APPDATA%\mongo-terminal-pro
 *   macOS:   ~/Library/Application Support/mongo-terminal-pro
 *   Linux:   $XDG_CONFIG_HOME/mongo-terminal-pro (default ~/.config/mongo-terminal-pro)
 * MTP_CONFIG_DIR overrides it (useful for portable installs and tests).
 */
export function resolveConfigDir(ctx: PathContext = {}): string {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const home = ctx.home ?? os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.MTP_CONFIG_DIR) return p.resolve(env.MTP_CONFIG_DIR);
  if (platform === 'win32') {
    const appData = env.APPDATA ?? p.join(home, 'AppData', 'Roaming');
    return p.join(appData, APP_NAME);
  }
  if (platform === 'darwin') {
    return p.join(home, 'Library', 'Application Support', APP_NAME);
  }
  const xdg =
    env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, '.config');
  return p.join(xdg, APP_NAME);
}

/** Default directory for backups and exports: ~/Documents/MongoTerminalPro when available. */
export function resolveDataDir(ctx: PathContext = {}): string {
  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;
  const home = ctx.home ?? os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.MTP_DATA_DIR) return p.resolve(env.MTP_DATA_DIR);
  if (platform === 'linux' && env.XDG_DATA_HOME && p.isAbsolute(env.XDG_DATA_HOME)) {
    return p.join(env.XDG_DATA_HOME, APP_NAME);
  }
  if (platform === 'linux') return p.join(home, '.local', 'share', APP_NAME);
  return p.join(home, 'Documents', 'MongoTerminalPro');
}

export interface AppPaths {
  configDir: string;
  dataDir: string;
  settingsFile: string;
  connectionsFile: string;
  credentialsFile: string;
  masterKeyFile: string;
  historyFile: string;
  backupHistoryFile: string;
  logDir: string;
  logFile: string;
  backupsDir: string;
  exportsDir: string;
}

export function getAppPaths(ctx: PathContext = {}): AppPaths {
  const configDir = resolveConfigDir(ctx);
  const dataDir = resolveDataDir(ctx);
  const p = (ctx.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  return {
    configDir,
    dataDir,
    settingsFile: p.join(configDir, 'settings.json'),
    connectionsFile: p.join(configDir, 'connections.json'),
    credentialsFile: p.join(configDir, 'credentials.enc.json'),
    masterKeyFile: p.join(configDir, 'master.key'),
    historyFile: p.join(configDir, 'history.json'),
    backupHistoryFile: p.join(configDir, 'backup-history.json'),
    logDir: p.join(configDir, 'logs'),
    logFile: p.join(configDir, 'logs', 'mongo-terminal-pro.log'),
    backupsDir: p.join(dataDir, 'backups'),
    exportsDir: p.join(dataDir, 'exports'),
  };
}
