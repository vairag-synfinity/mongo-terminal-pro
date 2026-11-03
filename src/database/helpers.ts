import type { AbstractCursor, Document } from 'mongodb';

/** Runs async work over items with bounded concurrency (avoids flooding the server). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Reads at most `max` documents from a cursor and always closes it. This is the only way the
 * application materialises query results — there is no unbounded toArray().
 */
export async function takeFromCursor<T extends Document>(
  cursor: AbstractCursor<T>,
  max: number,
  signal?: AbortSignal,
): Promise<{ documents: T[]; exhausted: boolean }> {
  const documents: T[] = [];
  let exhausted = false;
  try {
    while (documents.length < max) {
      if (signal?.aborted) break;
      const doc = await cursor.next();
      if (doc === null) {
        exhausted = true;
        break;
      }
      documents.push(doc);
    }
    if (!exhausted && documents.length >= max) {
      exhausted = !(await cursor.hasNext());
    }
  } finally {
    await cursor.close().catch(() => undefined);
  }
  return { documents, exhausted };
}

export function isUnauthorized(error: unknown): boolean {
  const e = error as { code?: number; codeName?: string; message?: string };
  return e?.code === 13 || e?.codeName === 'Unauthorized' || /not authorized/i.test(e?.message ?? '');
}

export function isCommandNotFound(error: unknown): boolean {
  const e = error as { code?: number; codeName?: string };
  return e?.code === 59 || e?.codeName === 'CommandNotFound' || e?.code === 40324 || e?.code === 40415;
}

export function elapsed(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}
