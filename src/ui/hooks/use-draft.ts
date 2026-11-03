import { useCallback, useState } from 'react';
import { useUi } from '../context.js';

/**
 * Like useState, but the value is kept in an app-wide draft store so typed queries, pipelines and
 * forms survive navigating away (e.g. pressing Esc by accident).
 */
export function useDraft<T>(key: string, initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void] {
  const { drafts } = useUi();
  const [value, setValue] = useState<T>(() => {
    if (drafts.has(key)) return drafts.get(key) as T;
    return typeof initial === 'function' ? (initial as () => T)() : initial;
  });
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
        drafts.set(key, resolved);
        return resolved;
      });
    },
    [drafts, key],
  );
  return [value, set];
}
