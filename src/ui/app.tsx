import { Box, Text, useApp as useInkApp, useInput, useWindowSize } from 'ink';
import React, { useCallback, useMemo, useState } from 'react';
import type { Settings } from '../config/defaults.js';
import type { Application } from '../core/application.js';
import type { TerminalCapabilities } from '../utils/terminal.js';
import { ConfirmDialog, type ConfirmOptions } from './components/dialog.js';
import { KeyHints, Notifications, type KeyHint } from './components/feedback.js';
import {
  ScreenActiveContext,
  UiProvider,
  errorNotifier,
  useAppState,
  useInputFocusRegistry,
  useNavigationState,
  useUi,
  type Route,
  type UiContextValue,
} from './context.js';
import { Header, HintsContext, LayoutContext } from './layouts/layout.js';
import { renderScreen } from './screens/registry.js';
import { col, createTheme, UNICODE_SYMBOLS, ASCII_SYMBOLS } from './themes/theme.js';

export interface AppProps {
  app: Application;
  initialSettings: Settings;
  caps: TerminalCapabilities;
  initialRoute: Route | Route[];
  overrides: { color?: 'no-color'; unicode?: 'ascii' | 'unicode'; theme?: 'dark' | 'light' };
  onQuit(): void;
}

export const MIN_COLUMNS = 40;
export const MIN_ROWS = 12;

export function App({ app, initialSettings, caps, initialRoute, overrides, onQuit }: AppProps) {
  const [settings, setSettings] = useState(initialSettings);
  const nav = useNavigationState(initialRoute);
  const inputFocus = useInputFocusRegistry();
  const [drafts] = useState(() => new Map<string, unknown>());
  const [writeDialog, setWriteDialog] = useState<ConfirmOptions | undefined>();
  const { exit } = useInkApp();

  const noColor =
    overrides.color === 'no-color' ||
    settings.colorMode === 'no-color' ||
    (settings.colorMode === 'auto' && caps.colorLevel === 0);
  const unicode = overrides.unicode
    ? overrides.unicode === 'unicode'
    : settings.unicodeMode === 'auto'
      ? caps.unicode
      : settings.unicodeMode === 'unicode';
  const theme = useMemo(
    () => createTheme(overrides.theme ?? settings.theme, noColor),
    [overrides.theme, settings.theme, noColor],
  );
  const symbols = unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS;

  const notify = useCallback<UiContextValue['notify']>(
    (level, title, message) => {
      app.state.notify(level, title, message);
    },
    [app],
  );
  const notifyError = useMemo(() => errorNotifier(notify), [notify]);

  const updateSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = await app.config.patch(patch);
      setSettings(next);
      app.events.emit('settings:changed', { keys: Object.keys(patch) });
    },
    [app],
  );

  const quit = useCallback(() => {
    onQuit();
    exit();
  }, [exit, onQuit]);

  const requestWriteAccess = useCallback(() => {
    const state = app.state.getSnapshot();
    if (!state.connected) {
      notify('warning', 'Not connected', 'Connect to a server first.');
      return;
    }
    if (state.writeEnabled) {
      app.disableWrites();
      notify('success', 'Write access disabled', 'The session is read-only again.');
      return;
    }
    const req = app.permissions.enableWriteRequirement();
    if (!req.allowed) {
      notify('error', 'Write access unavailable', req.reason);
      return;
    }
    setWriteDialog({
      title: 'Enable write access',
      message: [
        `Connection: ${state.connectionName}${state.production ? ' (PRODUCTION)' : ''}`,
        'Inserts, updates, deletes, imports, index changes and restores will be allowed for this session.',
        'Destructive operations still ask for confirmation. Press W again to return to read-only.',
      ],
      confirmLabel: 'Enable writes',
      danger: state.production,
      typeToConfirm: req.confirmation === 'type-name' ? state.connectionName : undefined,
    });
  }, [app, notify]);

  const value: UiContextValue = {
    app,
    settings,
    updateSettings,
    theme,
    symbols,
    caps,
    nav,
    notify,
    notifyError,
    inputFocus,
    requestWriteAccess,
    quit,
    drafts,
  };

  return (
    <UiProvider value={value}>
      <Shell writeDialog={writeDialog} closeWriteDialog={() => setWriteDialog(undefined)} />
    </UiProvider>
  );
}

function Shell({
  writeDialog,
  closeWriteDialog,
}: {
  writeDialog: ConfirmOptions | undefined;
  closeWriteDialog(): void;
}) {
  const ui = useUi();
  const { app, nav, theme, inputFocus, notify, notifyError } = ui;
  const state = useAppState();
  const { columns, rows } = useWindowSize();
  const [hints, setHints] = useState<KeyHint[]>([]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      ui.quit();
      return;
    }
    if (key.ctrl && input === 'x') {
      app.state.clearNotifications();
      return;
    }
    if (writeDialog || inputFocus.active) return;
    if (input === '?' && nav.current.screen !== 'help') nav.push('help');
    else if (input === 'W') ui.requestWriteAccess();
    else if (input === 'Q') ui.quit();
  });

  const width = Math.max(MIN_COLUMNS, columns);
  if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
    return (
      <Box flexDirection="column">
        <Text color={col(theme, theme.colors.warning)}>
          Terminal too small ({columns}x{rows}).
        </Text>
        <Text>
          Resize to at least {MIN_COLUMNS}x{MIN_ROWS}. Ctrl+C quits.
        </Text>
      </Box>
    );
  }
  const compact = columns < 80 || rows < 24;
  const headerHeight = 3;
  const notificationLines = state.notifications
    .slice(-3)
    .reduce((a, n) => a + 1 + Math.min(3, (n.message ?? '').split('\n').filter(Boolean).length), 0);
  // One spare row avoids full-screen clears that cause flicker in some terminals.
  const bodyHeight = Math.max(4, rows - headerHeight - 1 - notificationLines - 1);
  const layout = { width, height: bodyHeight, compact, wide: columns >= 120 };
  const globalHints: KeyHint[] = [
    { key: '?', label: 'help' },
    ...(state.connected ? [{ key: 'W', label: state.writeEnabled ? 'read-only' : 'write' }] : []),
    { key: 'Ctrl+C', label: 'quit' },
  ];

  return (
    <Box flexDirection="column" width={width} height={rows - 1}>
      <Header width={width} compact={compact} />
      <Box height={bodyHeight} flexDirection="column" overflow="hidden">
        <ScreenActiveContext.Provider value={!writeDialog}>
          <HintsContext.Provider value={setHints}>
            <LayoutContext.Provider value={layout}>
              <Box display={writeDialog ? 'none' : 'flex'} flexDirection="column" height={bodyHeight}>
                {renderScreen(nav.current)}
              </Box>
            </LayoutContext.Provider>
          </HintsContext.Provider>
        </ScreenActiveContext.Provider>
        {writeDialog ? (
          <Box justifyContent="center" marginTop={1}>
            <ConfirmDialog
              options={writeDialog}
              width={Math.min(90, width - 4)}
              onResult={(ok) => {
                closeWriteDialog();
                if (!ok) return;
                try {
                  app.enableWrites(writeDialog.typeToConfirm);
                  notify(
                    'warning',
                    'Write access enabled',
                    'Data-modifying operations are now allowed. Press W to return to read-only.',
                  );
                } catch (e) {
                  notifyError(e);
                }
              }}
            />
          </Box>
        ) : null}
      </Box>
      <Notifications items={state.notifications} width={width} onDismiss={(id) => app.state.dismiss(id)} />
      <KeyHints hints={[...hints, ...globalHints]} width={width} />
    </Box>
  );
}
