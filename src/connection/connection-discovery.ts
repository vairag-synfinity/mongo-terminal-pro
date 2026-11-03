import type { ConnectionStorage } from './connection-storage.js';
import type { ConnectionProfile, DiscoveredConnection } from './connection-types.js';
import { detectKind } from './manual-connection.js';

export { discoverCompassConnections, parseCompassExportFile } from './compass-discovery.js';
export {
  candidatesToConnections,
  collectFromEnvironment,
  collectFromProjectDirectory,
} from './env-discovery.js';

/** Marks discovered connections that already exist as saved profiles. */
export function markExisting(
  discovered: DiscoveredConnection[],
  profiles: ConnectionProfile[],
): (DiscoveredConnection & { alreadySaved: boolean })[] {
  return discovered.map((d) => ({
    ...d,
    alreadySaved: profiles.some((p) => p.uri === d.uri && (p.username ?? '') === (d.username ?? '')),
  }));
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base.slice(0, 90);
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${base.slice(0, 85)} (${n++})`;
  taken.add(name.toLowerCase());
  return name;
}

export interface ImportOutcome {
  imported: ConnectionProfile[];
  needPassword: ConnectionProfile[];
}

/**
 * Imports discovered connections as saved profiles. Passwords are only stored when explicitly
 * supplied (`secrets`) and `persistSecrets` is true.
 */
export async function importDiscovered(
  storage: ConnectionStorage,
  selected: DiscoveredConnection[],
  secrets: Map<string, string> = new Map(),
  persistSecrets = false,
): Promise<ImportOutcome> {
  const taken = new Set((await storage.list()).map((p) => p.name.toLowerCase()));
  const imported: ConnectionProfile[] = [];
  const needPassword: ConnectionProfile[] = [];
  for (const d of selected) {
    const password = secrets.get(d.key);
    const profile = await storage.create(
      {
        name: uniqueName(d.name, taken),
        kind: detectKind(d.uri),
        uri: d.uri,
        username: d.username,
        password,
        favorite: d.favorite,
        source: d.source,
        notes: `Imported from ${d.source === 'compass' ? 'MongoDB Compass' : 'environment'} (${d.origin})`,
      },
      { savePassword: persistSecrets },
    );
    imported.push(profile);
    if (d.passwordRequired && !password) needPassword.push(profile);
  }
  return { imported, needPassword };
}
