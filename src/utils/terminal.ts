import { getPlatformInfo } from './platform.js';

export type ColorLevel = 0 | 1 | 2 | 3;

export interface TerminalCapabilities {
  isTTY: boolean;
  colorLevel: ColorLevel;
  unicode: boolean;
  columns: number;
  rows: number;
  /** Mouse reporting is only enabled when the user opts in; this reports whether it is plausible. */
  mouseCapable: boolean;
}

export interface CapabilityOverrides {
  color?: 'auto' | 'color' | 'no-color';
  unicode?: 'auto' | 'unicode' | 'ascii';
}

/** Colour detection that follows the NO_COLOR / FORCE_COLOR conventions. */
export function detectColorLevel(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
  platform: NodeJS.Platform = process.platform,
): ColorLevel {
  if ('NO_COLOR' in env && env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 0;
  if (env.FORCE_COLOR !== undefined) {
    if (env.FORCE_COLOR === '0' || env.FORCE_COLOR === 'false') return 0;
    const forced = Number.parseInt(env.FORCE_COLOR, 10);
    if (forced >= 1 && forced <= 3) return forced as ColorLevel;
    return 1;
  }
  if (!isTTY) return 0;
  if (env.TERM === 'dumb') return 0;
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 3;
  if (platform === 'win32') {
    // Windows 10 build 14931+ supports 256/true colour in conhost and Windows Terminal.
    if (env.WT_SESSION) return 3;
    return 2;
  }
  if (env.TERM_PROGRAM === 'iTerm.app' || env.TERM_PROGRAM === 'vscode') return 3;
  if (env.TERM && /-256(color)?$/i.test(env.TERM)) return 2;
  if (env.TERM && /^(screen|xterm|vt100|vt220|rxvt|color|ansi|cygwin|linux|tmux)/i.test(env.TERM)) return 1;
  return env.TERM ? 1 : 0;
}

/**
 * Unicode box-drawing support heuristic. Legacy Windows conhost (CMD/PowerShell outside Windows
 * Terminal) and non-UTF-8 locales fall back to ASCII.
 */
export function detectUnicode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.MTP_ASCII === '1') return false;
  if (env.MTP_UNICODE === '1') return true;
  if (env.TERM === 'dumb' || env.TERM === 'linux') return false;
  if (platform === 'win32') {
    return Boolean(
      env.WT_SESSION ||
      env.TERM_PROGRAM === 'vscode' ||
      env.ConEmuTask === '{cmd::Cmder}' ||
      env.TERMINAL_EMULATOR === 'JetBrains-JediTerm' ||
      env.TERM === 'xterm-256color' ||
      env.TERM === 'alacritty',
    );
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || '';
  if (locale === '') return platform === 'darwin';
  return /UTF-?8$/i.test(locale) || /UTF-?8/i.test(locale);
}

export function detectCapabilities(
  overrides: CapabilityOverrides = {},
  env: NodeJS.ProcessEnv = process.env,
  stream: NodeJS.WriteStream = process.stdout,
): TerminalCapabilities {
  const isTTY = Boolean(stream.isTTY);
  let colorLevel = detectColorLevel(env, isTTY);
  if (overrides.color === 'no-color') colorLevel = 0;
  if (overrides.color === 'color' && colorLevel === 0) colorLevel = 1;
  let unicode = detectUnicode(env);
  if (overrides.unicode === 'ascii') unicode = false;
  if (overrides.unicode === 'unicode') unicode = true;
  const info = getPlatformInfo(env);
  return {
    isTTY,
    colorLevel,
    unicode,
    columns: stream.columns && stream.columns > 0 ? stream.columns : 80,
    rows: stream.rows && stream.rows > 0 ? stream.rows : 24,
    mouseCapable: isTTY && env.TERM !== 'dumb' && !(info.isWindows && !env.WT_SESSION && !env.TERM_PROGRAM),
  };
}

const ESC = '\u001B[';

export const terminalSequences = {
  showCursor: `${ESC}?25h`,
  hideCursor: `${ESC}?25l`,
  enterAltScreen: `${ESC}?1049h`,
  exitAltScreen: `${ESC}?1049l`,
  // SGR extended mouse mode: button events + wheel, reported as ESC[<b;x;yM
  enableMouse: `${ESC}?1000h${ESC}?1006h`,
  disableMouse: `${ESC}?1000l${ESC}?1006l`,
  resetAttributes: `${ESC}0m`,
};

export interface MouseEvent {
  kind: 'wheel-up' | 'wheel-down' | 'press' | 'release';
  button: number;
  x: number;
  y: number;
}

// eslint-disable-next-line no-control-regex -- matches terminal escape sequences
const SGR_MOUSE = /\u001B?\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Parses SGR (1006) mouse reports. Returns an empty array for non-mouse input. */
export function parseMouseInput(data: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const match of data.matchAll(SGR_MOUSE)) {
    const code = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const release = match[4] === 'm';
    if (code === 64) events.push({ kind: 'wheel-up', button: code, x, y });
    else if (code === 65) events.push({ kind: 'wheel-down', button: code, x, y });
    else events.push({ kind: release ? 'release' : 'press', button: code & 3, x, y });
  }
  return events;
}

export function isMouseSequence(input: string): boolean {
  // eslint-disable-next-line no-control-regex -- matches terminal escape sequences
  return /^\u001B?\[<\d+;\d+;\d+[Mm]/.test(input) || /^\[<\d+;\d+;\d+[Mm]/.test(input);
}

let restoreRegistered = false;
let mouseEnabled = false;

export function setMouseReporting(stream: NodeJS.WriteStream, enabled: boolean): void {
  if (!stream.isTTY) return;
  stream.write(enabled ? terminalSequences.enableMouse : terminalSequences.disableMouse);
  mouseEnabled = enabled;
}

/**
 * Restores terminal state (cursor, mouse reporting, attributes). Safe to call multiple times and
 * from crash handlers.
 */
export function restoreTerminal(stream: NodeJS.WriteStream = process.stdout): void {
  if (!stream.isTTY) return;
  try {
    if (mouseEnabled) stream.write(terminalSequences.disableMouse);
    stream.write(terminalSequences.resetAttributes + terminalSequences.showCursor);
    mouseEnabled = false;
  } catch {
    // The stream may already be closed during shutdown.
  }
}

export function registerTerminalRestore(): void {
  if (restoreRegistered) return;
  restoreRegistered = true;
  process.on('exit', () => restoreTerminal());
}
