import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload(): void;
  /** Aborts the in-flight request (e.g. Esc during a long operation). */
  cancel(): void;
}

/**
 * Runs an async loader and tracks its state. Stale results are ignored when deps change or the
 * component unmounts; an AbortSignal is passed for operations that support cancellation.
 */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  options: { enabled?: boolean } = {},
): AsyncState<T> {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: enabled,
  });
  const [tick, setTick] = useState(0);
  const controller = useRef<AbortController | undefined>(undefined);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    const ac = new AbortController();
    controller.current = ac;
    let alive = true;
    setState((s) => ({ data: s.data, error: undefined, loading: true }));
    loaderRef.current(ac.signal).then(
      (data) => {
        if (alive && !ac.signal.aborted) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (alive)
          setState((s) => ({ data: s.data, error: ac.signal.aborted ? undefined : error, loading: false }));
      },
    );
    return () => {
      alive = false;
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, enabled]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const cancel = useCallback(() => controller.current?.abort(), []);
  return { ...state, reload, cancel };
}

/** Runs an action with loading/error tracking (for buttons). */
export function useAction<A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
): { run: (...args: A) => Promise<R | undefined>; running: boolean; error: unknown } {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const run = useCallback(
    async (...args: A) => {
      setRunning(true);
      setError(undefined);
      try {
        return await action(...args);
      } catch (e) {
        if (mounted.current) setError(e);
        return undefined;
      } finally {
        if (mounted.current) setRunning(false);
      }
    },
    [action],
  );
  return { run, running, error };
}
