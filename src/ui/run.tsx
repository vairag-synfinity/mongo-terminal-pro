import { render } from 'ink';
import React from 'react';
import type { Application } from '../core/application.js';
import { AppError } from '../core/error-handler.js';
import {
  detectCapabilities,
  parseMouseInput,
  registerTerminalRestore,
  restoreTerminal,
  setMouseReporting,
} from '../utils/terminal.js';
import { App } from './app.js';
import type { Route, ScreenName } from './context.js';
import { MouseContext, createMouseBus } from './hooks/use-mouse.js';

export interface RunOptions {
  initialScreen?: string;
  connectionName?: string;
  overrides: { color?: 'no-color'; unicode?: 'ascii' | 'unicode'; theme?: 'dark' | 'light'; mouse?: boolean };
}

const SCREENS: ScreenName[] = [
  'dashboard',
  'connections',
  'databases',
  'settings',
  'monitoring',
  'backup',
  'help',
];

/** Starts the full-screen TUI and resolves when the user quits. */
export async function runTui(app: Application, options: RunOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new AppError(
      'The interactive dashboard needs an interactive terminal (TTY).',
      'VALIDATION',
      'Run it directly in a terminal, or use the non-interactive commands (see mongo-terminal --help). On Git Bash/mintty use "winpty mongo-terminal".',
    );
  }
  registerTerminalRestore();
  const settings = await app.settings();
  const caps = detectCapabilities({
    color: options.overrides.color ?? settings.colorMode,
    unicode: options.overrides.unicode ?? settings.unicodeMode,
  });
  const mouseEnabled = Boolean(options.overrides.mouse ?? settings.mouse) && caps.mouseCapable;
  const mouse = createMouseBus(mouseEnabled);

  // Like Compass, the app opens on the connection list; connecting opens the workspace on top.
  const home: Route = { screen: 'connections', params: {}, key: 1 };
  let initial: Route[] = [home];
  const requested = options.initialScreen as ScreenName | undefined;
  if (requested && requested !== 'connections' && SCREENS.includes(requested))
    initial = [home, { screen: requested, params: {}, key: 2 }];
  if (options.connectionName) {
    const profile = await app.connections.findByName(options.connectionName);
    if (!profile) throw new AppError(`No saved connection named "${options.connectionName}"`, 'NOT_FOUND');
    initial = [{ screen: 'connections', params: { autoConnect: profile.id }, key: 1 }];
  }

  const onData = (data: Buffer) => {
    for (const e of parseMouseInput(data.toString('latin1'))) mouse.emit(e);
  };
  if (mouseEnabled) {
    setMouseReporting(process.stdout, true);
    process.stdin.on('data', onData);
  }

  const instance = render(
    <MouseContext.Provider value={mouse}>
      <App
        app={app}
        initialSettings={settings}
        caps={caps}
        initialRoute={initial}
        overrides={options.overrides}
        onQuit={() => undefined}
      />
    </MouseContext.Provider>,
    { exitOnCtrlC: false, alternateScreen: true, patchConsole: true, maxFps: 30 },
  );

  const onSignal = () => instance.unmount();
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  try {
    await instance.waitUntilExit();
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGHUP', onSignal);
    if (mouseEnabled) {
      process.stdin.off('data', onData);
      setMouseReporting(process.stdout, false);
    }
    restoreTerminal();
    await app.shutdown();
  }
}
