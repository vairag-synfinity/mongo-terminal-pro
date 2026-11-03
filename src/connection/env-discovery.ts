import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describeSecretValue } from '../security/sensitive-data-filter.js';
import type { DiscoveredConnection } from './connection-types.js';
import { stripCredentials } from './manual-connection.js';

/**
 * Discovers MongoDB connection strings in environment variables and in `.env*` files of ONE
 * user-chosen project directory. It never recurses, never executes project code and never prints
 * secret values (passwords are masked; non-URI values are fully masked).
 */

export const KNOWN_VARIABLES = [
  'MONGODB_URI',
  'MONGO_URI',
  'MONGODB_URL',
  'MONGO_URL',
  'DATABASE_URL',
  'MONGO_CONNECTION_STRING',
  'MONGODB_CONNECTION_STRING',
  'ME_CONFIG_MONGODB_URL',
];

export const ENV_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.test',
  '.env.production',
  '.env.production.local',
  '.env.example',
];

const MAX_ENV_FILE_SIZE = 512 * 1024;

export interface EnvCandidate {
  variable: string;
  origin: string;
  value: string;
}

/** Minimal dotenv parser: KEY=VALUE, optional `export`, quotes, inline comments. No expansion. */
export function parseDotEnv(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] ?? '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    result.set(key, value);
  }
  return result;
}

function isMongoVariable(name: string, value: string): boolean {
  if (!/^mongodb(\+srv)?:\/\//i.test(value.trim())) return false;
  return KNOWN_VARIABLES.includes(name) || /MONGO/i.test(name) || /DATABASE|DB_URL|DB_URI/i.test(name);
}

export function collectFromEnvironment(env: NodeJS.ProcessEnv = process.env): EnvCandidate[] {
  return Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && isMongoVariable(entry[0], entry[1]),
    )
    .map(([variable, value]) => ({ variable, origin: 'process environment', value }));
}

export async function collectFromProjectDirectory(
  directory: string,
): Promise<{ candidates: EnvCandidate[]; filesRead: string[]; warnings: string[] }> {
  const dir = path.resolve(directory);
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a directory`);
  const candidates: EnvCandidate[] = [];
  const filesRead: string[] = [];
  const warnings: string[] = [];
  for (const name of ENV_FILES) {
    const file = path.join(dir, name);
    try {
      const s = await fs.stat(file);
      if (!s.isFile()) continue;
      if (s.size > MAX_ENV_FILE_SIZE) {
        warnings.push(`${name} is larger than 512 KB and was skipped`);
        continue;
      }
      const vars = parseDotEnv(await fs.readFile(file, 'utf8'));
      filesRead.push(file);
      for (const [variable, value] of vars) {
        if (isMongoVariable(variable, value)) candidates.push({ variable, origin: file, value });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read ${name}`);
    }
  }
  return { candidates, filesRead, warnings };
}

/**
 * Converts candidates to discovered connections. Passwords found in env values are returned
 * separately (keyed by discovery key) so the caller can offer to store them securely; they are
 * never included in display fields.
 */
export function candidatesToConnections(candidates: EnvCandidate[]): {
  connections: DiscoveredConnection[];
  secrets: Map<string, string>;
} {
  const connections: DiscoveredConnection[] = [];
  const secrets = new Map<string, string>();
  const seen = new Set<string>();
  for (const c of candidates) {
    try {
      const normalized = stripCredentials(c.value);
      const dedupe = `${normalized.uri}|${normalized.username ?? ''}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const key = `env:${c.origin}:${c.variable}`;
      if (normalized.password) secrets.set(key, normalized.password);
      const where = c.origin === 'process environment' ? 'env' : path.basename(c.origin);
      connections.push({
        key,
        name: `${c.variable} (${where})`,
        source: 'env',
        origin: c.origin,
        uri: normalized.uri,
        username: normalized.username,
        passwordRequired: Boolean(normalized.username) && !normalized.password,
        displayUri: describeSecretValue(c.value),
        notes: normalized.password ? ['Password found; it can be stored in secure credential storage'] : [],
      });
    } catch {
      // Not a parseable connection string; ignore.
    }
  }
  return { connections, secrets };
}
