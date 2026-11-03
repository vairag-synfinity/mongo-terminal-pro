import { useCallback, useEffect, useState } from 'react';
import { useUi } from '../context.js';
import { useAsync, type AsyncState } from './use-async.js';

interface CacheEntry<T> {
  data: T;
  at: number;
  connectionId?: string;
}

/**
 * Metadata cache (database/collection lists, stats). Results are reused when navigating back and
 * forth; pressing refresh (`reload`) or a metadata-invalidating action fetches fresh data. The cache
 * is scoped to the active connection.
 */
export function useCachedAsync<T>(
  key: string,
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
): AsyncState<T> & { cachedAt?: number } {
  const { drafts, app } = useUi();
  const cacheKey = `cache:${key}`;
  const connectionId = app.state.getSnapshot().connectionId;
  const cached = drafts.get(cacheKey) as CacheEntry<T> | undefined;
  const valid = cached && cached.connectionId === connectionId ? cached : undefined;
  const [force, setForce] = useState(0);

  const state = useAsync(
    async (signal) => {
      const data = await loader(signal);
      drafts.set(cacheKey, { data, at: Date.now(), connectionId } satisfies CacheEntry<T>);
      return data;
    },
    [cacheKey, force, ...deps],
    { enabled: !valid || force > 0 },
  );

  useEffect(
    () =>
      app.events.on('metadata:invalidated', () => {
        for (const k of [...drafts.keys()]) if (k.startsWith('cache:')) drafts.delete(k);
      }),
    [app, drafts],
  );

  const reload = useCallback(() => setForce((f) => f + 1), []);
  if (valid && force === 0) {
    return {
      data: valid.data,
      error: undefined,
      loading: false,
      reload,
      cancel: state.cancel,
      cachedAt: valid.at,
    };
  }
  return { ...state, reload, cachedAt: (drafts.get(cacheKey) as CacheEntry<T> | undefined)?.at };
}
