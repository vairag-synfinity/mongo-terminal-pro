import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Settings } from '../config/defaults.js';
import type { Application } from '../core/application.js';
import type { ApplicationStateShape, NotificationLevel } from '../core/application-state.js';
import { toFriendlyError } from '../core/error-handler.js';
import type { TerminalCapabilities } from '../utils/terminal.js';
import type { SymbolSet, Theme } from './themes/theme.js';

// ------------------------------------------------------------------------------------------------
// Navigation
// ------------------------------------------------------------------------------------------------

export type ScreenName =
  | 'dashboard'
  | 'connections'
  | 'databases'
  | 'collections'
  | 'collection'
  | 'documents'
  | 'query'
  | 'aggregation'
  | 'import'
  | 'export'
  | 'backup'
  | 'indexes'
  | 'monitoring'
  | 'settings'
  | 'help'
  | 'picker';

export interface Route {
  screen: ScreenName;
  params: Record<string, unknown>;
  /** Unique key so re-visiting a screen gets fresh state. */
  key: number;
}

export interface Navigation {
  stack: Route[];
  current: Route;
  push(screen: ScreenName, params?: Record<string, unknown>): void;
  replace(screen: ScreenName, params?: Record<string, unknown>): void;
  back(): void;
  home(): void;
}

// ------------------------------------------------------------------------------------------------
// App context
// ------------------------------------------------------------------------------------------------

export interface UiContextValue {
  app: Application;
  settings: Settings;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  theme: Theme;
  symbols: SymbolSet;
  caps: TerminalCapabilities;
  nav: Navigation;
  notify(level: NotificationLevel, title: string, message?: string): void;
  notifyError(error: unknown, title?: string): void;
  /** Text inputs register here so global single-key shortcuts are suppressed while typing. */
  inputFocus: { acquire(): () => void; active: boolean };
  /** Requests the write-access dialog. */
  requestWriteAccess(): void;
  /** Exit the TUI cleanly. */
  quit(): void;
  /** Draft storage that survives navigating away from a screen. */
  drafts: Map<string, unknown>;
}

export const UiContext = createContext<UiContextValue | null>(null);

export function useUi(): UiContextValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be used inside <UiContext.Provider>');
  return ctx;
}

export function useAppState(): ApplicationStateShape {
  const { app } = useUi();
  return useSyncExternalStore(app.state.subscribe, app.state.getSnapshot, app.state.getSnapshot);
}

/** Whether the current screen should receive keyboard input (false while a global dialog is open). */
export const ScreenActiveContext = createContext(true);
export const useScreenActive = () => useContext(ScreenActiveContext);

export function useNavigationState(initial: Route | Route[]): Navigation {
  const initialStack = Array.isArray(initial) ? initial : [initial];
  const [stack, setStack] = useState<Route[]>(initialStack);
  const nextKey = useRef(Math.max(...initialStack.map((r) => r.key)) + 1);
  const push = useCallback((screen: ScreenName, params: Record<string, unknown> = {}) => {
    setStack((s) => [...s, { screen, params, key: nextKey.current++ }]);
  }, []);
  const replace = useCallback((screen: ScreenName, params: Record<string, unknown> = {}) => {
    setStack((s) => [...s.slice(0, -1), { screen, params, key: nextKey.current++ }]);
  }, []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const home = useCallback(() => setStack((s) => s.slice(0, 1)), []);
  return useMemo(
    () => ({ stack, current: stack[stack.length - 1] as Route, push, replace, back, home }),
    [stack, push, replace, back, home],
  );
}

export function useInputFocusRegistry(): UiContextValue['inputFocus'] {
  const [count, setCount] = useState(0);
  const acquire = useCallback(() => {
    setCount((c) => c + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setCount((c) => c - 1);
    };
  }, []);
  return useMemo(() => ({ acquire, active: count > 0 }), [acquire, count]);
}

export function errorNotifier(notify: UiContextValue['notify']) {
  return (error: unknown, title?: string) => {
    const f = toFriendlyError(error);
    const details = (error as { details?: string[] }).details;
    const message = [f.message, ...(details ?? []).slice(0, 3), f.hint ? `Hint: ${f.hint}` : '']
      .filter(Boolean)
      .join('\n');
    notify('error', title ?? f.title, message);
  };
}

export function UiProvider({ value, children }: { value: UiContextValue; children: React.ReactNode }) {
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}
