import { useAppState, useUi } from '../context.js';
import { useAsync } from './use-async.js';

interface NameCache {
  connectionId?: string;
  names: string[];
  views?: string[];
}

/**
 * Existing database names and the collections of `database`, for pick-or-type form fields.
 * Results are cached per connection; collections are only listed for databases that exist.
 */
export function useNamespaceSuggestions(database: string | undefined): {
  databases: string[];
  collections: string[];
  /** Collections that can be written to (excludes views). */
  writableCollections: string[];
  loadingDatabases: boolean;
  loadingCollections: boolean;
} {
  const { app, drafts } = useUi();
  const state = useAppState();
  const connected = state.connected;
  const connectionId = state.connectionId;

  const cached = <T extends NameCache>(key: string): T | undefined => {
    const c = drafts.get(key) as T | undefined;
    return c && c.connectionId === connectionId ? c : undefined;
  };

  const dbKey = 'cache:names:databases';
  const dbs = useAsync(
    async () => {
      const hit = cached(dbKey);
      if (hit) return hit.names;
      const res = await app.db().databases.list();
      const names = res.databases.map((d) => d.name);
      drafts.set(dbKey, { connectionId, names } satisfies NameCache);
      return names;
    },
    [connectionId],
    { enabled: connected },
  );

  const db = database?.trim() ?? '';
  const exists = Boolean(db) && (dbs.data ?? []).includes(db);
  const collKey = `cache:names:collections:${db}`;
  const colls = useAsync(
    async () => {
      const hit = cached(collKey);
      if (hit) return hit;
      const list = await app.db().collections.list(db, { withStats: false });
      const usable = list.filter((c) => c.type !== 'system');
      const entry: NameCache = {
        connectionId,
        names: usable.map((c) => c.name),
        views: usable.filter((c) => c.type === 'view').map((c) => c.name),
      };
      drafts.set(collKey, entry);
      return entry;
    },
    [connectionId, db, exists],
    { enabled: connected && exists },
  );

  return {
    databases: dbs.data ?? [],
    collections: exists ? (colls.data?.names ?? []) : [],
    writableCollections: exists
      ? (colls.data?.names ?? []).filter((n) => !colls.data?.views?.includes(n))
      : [],
    loadingDatabases: dbs.loading,
    loadingCollections: exists && colls.loading,
  };
}

/** Clears cached names (after creating or dropping databases/collections). */
export function invalidateNameCache(drafts: Map<string, unknown>): void {
  for (const k of [...drafts.keys()]) if (k.startsWith('cache:names:')) drafts.delete(k);
}
