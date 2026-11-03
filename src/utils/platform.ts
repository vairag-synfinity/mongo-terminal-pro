import { accessSync, constants, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SupportedPlatform = 'win32' | 'darwin' | 'linux' | 'other';

export interface PlatformInfo {
  platform: SupportedPlatform;
  release: string;
  arch: string;
  isWindows: boolean;
  isMac: boolean;
  isLinux: boolean;
  isWSL: boolean;
  isSSH: boolean;
  isCI: boolean;
  terminalProgram: string | undefined;
  shell: string | undefined;
}

export function normalizePlatform(platform: NodeJS.Platform = process.platform): SupportedPlatform {
  if (platform === 'win32' || platform === 'darwin' || platform === 'linux') return platform;
  return 'other';
}

export function detectTerminalProgram(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.WT_SESSION) return 'Windows Terminal';
  if (env.TERM_PROGRAM === 'vscode') return 'VS Code';
  if (env.TERM_PROGRAM === 'iTerm.app') return 'iTerm2';
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 'macOS Terminal';
  if (env.ConEmuANSI === 'ON') return 'ConEmu';
  if (env.TERM_PROGRAM) return env.TERM_PROGRAM;
  if (env.TERMINAL_EMULATOR) return env.TERMINAL_EMULATOR;
  if (env.COLORTERM === 'kmscon') return 'kmscon';
  return env.TERM ?? undefined;
}

export function getPlatformInfo(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): PlatformInfo {
  const p = normalizePlatform(platform);
  const release = os.release();
  return {
    platform: p,
    release,
    arch: process.arch,
    isWindows: p === 'win32',
    isMac: p === 'darwin',
    isLinux: p === 'linux',
    isWSL: p === 'linux' && (/microsoft/i.test(release) || Boolean(env.WSL_DISTRO_NAME)),
    isSSH: Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY),
    isCI: Boolean(env.CI),
    terminalProgram: detectTerminalProgram(env),
    shell: env.SHELL ?? env.ComSpec ?? env.COMSPEC,
  };
}

function isExecutableFile(candidate: string, platform: SupportedPlatform): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates an executable on PATH without spawning a shell (`which`/`where` are shell-specific).
 * Honours PATHEXT on Windows.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  extraDirs: string[] = [],
): string | undefined {
  const p = normalizePlatform(platform);
  const pathApi = p === 'win32' ? path.win32 : path.posix;
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = [...pathVar.split(p === 'win32' ? ';' : ':'), ...extraDirs].filter(Boolean);
  const extensions =
    p === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
          .map((e) => e.toLowerCase())
      : [''];
  const hasExt = p === 'win32' && extensions.some((ext) => name.toLowerCase().endsWith(ext));
  for (const dir of dirs) {
    const cleanDir = dir.replace(/^"(.*)"$/, '$1');
    const candidates = hasExt ? [name] : extensions.map((ext) => name + ext);
    for (const candidate of candidates) {
      const full = pathApi.join(cleanDir, candidate);
      if (isExecutableFile(full, p)) return full;
    }
  }
  return undefined;
}

export function homeDir(): string {
  return os.homedir();
}
