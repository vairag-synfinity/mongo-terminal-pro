import React from 'react';
import type { Application } from '../../src/core/application.js';
import { ApplicationState } from '../../src/core/application-state.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { UiProvider, type UiContextValue } from '../../src/ui/context.js';
import { LayoutContext } from '../../src/ui/layouts/layout.js';
import { ASCII_SYMBOLS, createTheme, UNICODE_SYMBOLS } from '../../src/ui/themes/theme.js';

/** Minimal providers for rendering components in isolation (no database needed). */
export function TestProviders({
  children,
  unicode = true,
  noColor = true,
  width = 80,
  height = 24,
  app,
}: {
  children: React.ReactNode;
  unicode?: boolean;
  noColor?: boolean;
  width?: number;
  height?: number;
  app?: Partial<Application>;
}) {
  const notifications: { level: string; title: string; message?: string }[] = [];
  const value: UiContextValue = {
    app: (app ?? { state: new ApplicationState() }) as Application,
    settings: DEFAULT_SETTINGS,
    updateSettings: async () => undefined,
    theme: createTheme('dark', noColor),
    symbols: unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS,
    caps: {
      isTTY: true,
      colorLevel: noColor ? 0 : 3,
      unicode,
      columns: width,
      rows: height,
      mouseCapable: false,
    },
    nav: {
      stack: [{ screen: 'dashboard', params: {}, key: 1 }],
      current: { screen: 'dashboard', params: {}, key: 1 },
      push: () => undefined,
      replace: () => undefined,
      back: () => undefined,
      home: () => undefined,
    },
    notify: (level, title, message) => notifications.push({ level, title, message }),
    notifyError: () => undefined,
    inputFocus: { acquire: () => () => undefined, active: false },
    requestWriteAccess: () => undefined,
    quit: () => undefined,
    drafts: new Map(),
  };
  return (
    <UiProvider value={value}>
      <LayoutContext.Provider value={{ width, height, compact: width < 80, wide: width >= 120 }}>
        {children}
      </LayoutContext.Provider>
    </UiProvider>
  );
}
