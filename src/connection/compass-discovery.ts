import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskConnectionString } from '../security/sensitive-data-filter.js';
import type { DiscoveredConnection } from './connection-types.js';
import { stripCredentials } from './manual-connection.js';

/**
 * Discovers MongoDB Compass saved connections — READ ONLY.
 *
 * Compass formats differ by version:
 *  - 1.39+ : <config>/Connections/<uuid>.json with
 *            { connectionInfo: { connectionOptions: { connectionString }, favorite: { name } },
 *              connectionSecrets: "<safeStorage-encrypted blob>" }
 *            The password is stripped from connectionString and encrypted with Electron safeStorage,
 *            i.e. the OS keychain / DPAPI. We do NOT attempt to decrypt it.
 *  - 1.2x–1.38: similar files, secrets stored in the OS keychain via keytar (not readable here).
 *  - legacy  : model files with hostname/port/... fields.
 * Any credential that cannot be safely recovered is flagged so the user enters it manually.
 * Compass files are opened read-only and never modified.
 */

export const COMPASS_VARIANTS = [
  'MongoDB Compass',
  'MongoDB Compass Readonly',
  'MongoDB Compass Isolated Edition',
  'MongoDB Compass Beta',
  'MongoDB Compass Dev',
];

export interface DiscoveryContext {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface CompassInstallation {
  variant: string;
  configDir: string;
  version?: string;
  connectionFiles: number;
}

export interface CompassDiscoveryResult {
  installed: boolean;
  executablePaths: string[];
  installations: CompassInstallation[];
  connections: DiscoveredConnection[];
  warnings: string[];
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function compassConfigRoots(ctx: DiscoveryContext = {}): string[] {
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? os.homedir();
  const p = pathApi(platform);
  if (platform === 'win32') {
    return [env.APPDATA ?? p.join(home, 'AppData', 'Roaming')];
  }
  if (platform === 'darwin') {
    return [p.join(home, 'Library', 'Application Support')];
  }
  const roots = [
    env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, '.config'),
  ];
  roots.push(p.join(home, 'snap', 'mongodb-compass', 'current', '.config'));
  roots.push(p.join(home, '.var', 'app', 'com.mongodb.Compass', 'config'));
  return roots;
}

export function compassExecutableCandidates(ctx: DiscoveryContext = {}): string[] {
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const home = ctx.home ?? os.homedir();
  const p = pathApi(platform);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local');
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
    return [
      p.join(local, 'MongoDBCompass', 'MongoDBCompass.exe'),
      p.join(local, 'MongoDBCompassReadonly', 'MongoDBCompassReadonly.exe'),
      p.join(programFiles, 'MongoDB Compass', 'MongoDBCompass.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/MongoDB Compass.app',
      '/Applications/MongoDB Compass Readonly.app',
      p.join(home, 'Applications', 'MongoDB Compass.app'),
    ];
  }
  return [
    '/usr/bin/mongodb-compass',
    '/usr/bin/mongodb-compass-readonly',
    '/usr/lib/mongodb-compass',
    '/usr/share/mongodb-compass',
    '/opt/mongodb-compass',
    '/snap/bin/mongodb-compass',
  ];
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<unknown> {
  // Opened read-only; Compass files are never written.
  const handle = await fs.open(file, 'r');
  try {
    const text = await handle.readFile({ encoding: 'utf8' });
    return JSON.parse(text);
  } finally {
    await handle.close();
  }
}

interface ModernCompassFile {
  _id?: string;
  connectionInfo?: {
    id?: string;
    connectionOptions?: { connectionString?: string };
    favorite?: { name?: string };
    savedConnectionType?: string;
    lastUsed?: string;
  };
  connectionSecrets?: unknown;
}

interface LegacyCompassFile {
  _id?: string;
  name?: string;
  hostname?: string;
  port?: number;
  ns?: string;
  replicaSet?: string;
  authStrategy?: string;
  mongodb_username?: string;
  mongodb_database_name?: string;
  isSrvRecord?: boolean;
  ssl?: string;
  sslMethod?: string;
  isFavorite?: boolean;
}

/** Parses a single Compass connection document (any supported format). Exported for tests. */
export function parseCompassConnection(raw: unknown, origin: string): DiscoveredConnection | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const modern = raw as ModernCompassFile;
  const notes: string[] = [];
  let connectionString = modern.connectionInfo?.connectionOptions?.connectionString;
  let name = modern.connectionInfo?.favorite?.name;
  const favorite = Boolean(
    modern.connectionInfo?.savedConnectionType === 'favorite' || modern.connectionInfo?.favorite,
  );
  let key = modern.connectionInfo?.id ?? modern._id;

  if (!connectionString) {
    const legacy = raw as LegacyCompassFile;
    if (!legacy.hostname) return undefined;
    const scheme = legacy.isSrvRecord ? 'mongodb+srv' : 'mongodb';
    const host = legacy.isSrvRecord ? legacy.hostname : `${legacy.hostname}:${legacy.port ?? 27017}`;
    const params = new URLSearchParams();
    if (legacy.replicaSet) params.set('replicaSet', legacy.replicaSet);
    if (legacy.mongodb_database_name) params.set('authSource', legacy.mongodb_database_name);
    if (legacy.ssl && legacy.ssl !== 'NONE') params.set('tls', 'true');
    if (legacy.sslMethod && legacy.sslMethod !== 'NONE') params.set('tls', 'true');
    const query = params.toString();
    connectionString = `${scheme}://${host}/${query ? `?${query}` : ''}`;
    if (legacy.mongodb_username) {
      connectionString = connectionString.replace(
        '://',
        `://${encodeURIComponent(legacy.mongodb_username)}@`,
      );
    }
    name = legacy.name;
    key = legacy._id ?? key;
    notes.push('Legacy Compass format');
  }

  let normalized;
  try {
    normalized = stripCredentials(connectionString);
  } catch {
    return undefined;
  }
  const hasEncryptedSecrets =
    typeof modern.connectionSecrets === 'string'
      ? modern.connectionSecrets.length > 0
      : Boolean(modern.connectionSecrets);
  const authMechanism = normalized.authMechanism?.toUpperCase();
  const passwordlessMechanism =
    authMechanism === 'MONGODB-X509' ||
    authMechanism === 'MONGODB-AWS' ||
    authMechanism === 'GSSAPI' ||
    authMechanism === 'MONGODB-OIDC';
  const passwordRequired = Boolean(normalized.username) && !passwordlessMechanism;
  if (passwordRequired) {
    notes.push(
      hasEncryptedSecrets
        ? 'Password is protected by Compass (OS-encrypted) and will be requested'
        : 'Password not stored in a readable form; it will be requested',
    );
  }
  if (normalized.password) notes.push('A plain-text password in the Compass file was ignored for safety');
  const displayHost = normalized.hosts[0] ?? 'unknown host';
  return {
    key: `compass:${key ?? origin}`,
    name: name?.trim() || displayHost,
    source: 'compass',
    origin,
    uri: normalized.uri,
    username: normalized.username,
    passwordRequired,
    displayUri: maskConnectionString(normalized.uri),
    favorite,
    notes,
  };
}

async function readVersion(configDir: string, p: typeof path.posix): Promise<string | undefined> {
  try {
    const prefs = (await readJson(p.join(configDir, 'AppPreferences', 'General.json'))) as {
      lastKnownVersion?: string;
      highestInstalledVersion?: string;
    };
    return prefs.lastKnownVersion ?? prefs.highestInstalledVersion;
  } catch {
    return undefined;
  }
}

export async function discoverCompassConnections(
  ctx: DiscoveryContext = {},
): Promise<CompassDiscoveryResult> {
  const platform = ctx.platform ?? process.platform;
  const p = pathApi(platform);
  const warnings: string[] = [];
  const executablePaths: string[] = [];
  for (const candidate of compassExecutableCandidates(ctx)) {
    if (await exists(candidate)) executablePaths.push(candidate);
  }

  const installations: CompassInstallation[] = [];
  const connections: DiscoveredConnection[] = [];
  const seenUris = new Set<string>();

  for (const root of compassConfigRoots(ctx)) {
    for (const variant of COMPASS_VARIANTS) {
      const configDir = p.join(root, variant);
      if (!(await exists(configDir))) continue;
      const connectionsDir = p.join(configDir, 'Connections');
      let files: string[] = [];
      try {
        files = (await fs.readdir(connectionsDir)).filter((f) => f.toLowerCase().endsWith('.json'));
      } catch {
        // No Connections directory: older Compass versions keep connections in IndexedDB.
      }
      installations.push({
        variant,
        configDir,
        version: await readVersion(configDir, p),
        connectionFiles: files.length,
      });
      if (files.length === 0 && (await exists(p.join(configDir, 'IndexedDB')))) {
        warnings.push(
          `${variant}: connections are stored in an internal database this Compass version uses; export them from Compass (Connections → Export) and import the file instead.`,
        );
      }
      for (const file of files) {
        const full = p.join(connectionsDir, file);
        try {
          const parsed = parseCompassConnection(await readJson(full), full);
          if (!parsed) continue;
          const dedupeKey = `${parsed.uri}|${parsed.username ?? ''}`;
          if (seenUris.has(dedupeKey)) continue;
          seenUris.add(dedupeKey);
          connections.push(parsed);
        } catch {
          warnings.push(`Skipped unreadable Compass file ${file}`);
        }
      }
    }
  }
  return {
    installed: executablePaths.length > 0 || installations.length > 0,
    executablePaths,
    installations,
    connections,
    warnings,
  };
}

/**
 * Parses a file produced by Compass "Export saved connections". Encrypted exports (with a
 * passphrase) keep their secrets encrypted; we only import the non-secret parts.
 */
export async function parseCompassExportFile(file: string): Promise<DiscoveredConnection[]> {
  const raw = (await readJson(file)) as { type?: string; connections?: unknown[] };
  if (!raw || !Array.isArray(raw.connections)) {
    throw new Error('Not a Compass connections export file (expected a "connections" array)');
  }
  const out: DiscoveredConnection[] = [];
  for (const entry of raw.connections) {
    const e = entry as {
      id?: string;
      connectionOptions?: unknown;
      favorite?: unknown;
      connectionSecrets?: unknown;
    };
    const parsed = parseCompassConnection(
      {
        connectionInfo: { id: e.id, connectionOptions: e.connectionOptions, favorite: e.favorite },
        connectionSecrets: e.connectionSecrets,
      },
      file,
    );
    if (parsed) out.push(parsed);
  }
  return out;
}
