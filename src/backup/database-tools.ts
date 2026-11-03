import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConnectionString } from 'mongodb-connection-string-url';
import type { ConnectionProfile } from '../connection/connection-types.js';
import { AppError } from '../core/error-handler.js';
import { redactText } from '../security/sensitive-data-filter.js';
import { findExecutable } from '../utils/platform.js';

export type ToolName = 'mongodump' | 'mongorestore' | 'mongoexport' | 'mongoimport';
export const TOOL_NAMES: ToolName[] = ['mongodump', 'mongorestore', 'mongoexport', 'mongoimport'];

export interface ToolInfo {
  name: ToolName;
  path?: string;
  version?: string;
}

function extraToolDirs(): string[] {
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      path.win32.join(pf, 'MongoDB', 'Tools', '100', 'bin'),
      path.win32.join(pf, 'MongoDB', 'Server', '8.0', 'bin'),
      path.win32.join(pf, 'MongoDB', 'Server', '7.0', 'bin'),
    ];
  }
  if (process.platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin'];
  return ['/usr/bin', '/usr/local/bin', '/snap/bin'];
}

export function locateTool(name: ToolName, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env[`MTP_${name.toUpperCase()}_PATH`];
  if (override) return override;
  return findExecutable(name, env, process.platform, extraToolDirs());
}

export async function toolVersion(toolPath: string): Promise<string | undefined> {
  try {
    const { stdout, code } = await runProcess(toolPath, ['--version'], { timeoutMs: 10_000 });
    if (code !== 0) return undefined;
    return /version:?\s*r?([\d.]+)/i.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

export async function detectTools(): Promise<ToolInfo[]> {
  return Promise.all(
    TOOL_NAMES.map(async (name) => {
      const p = locateTool(name);
      return { name, path: p, version: p ? await toolVersion(p) : undefined };
    }),
  );
}

export function installInstructions(platform: NodeJS.Platform = process.platform): string[] {
  const common = 'Download page: https://www.mongodb.com/try/download/database-tools';
  if (platform === 'win32') {
    return [
      'Install MongoDB Database Tools for Windows:',
      '  winget install MongoDB.DatabaseTools',
      '  or download the MSI from the page below.',
      'Then add C:\\Program Files\\MongoDB\\Tools\\100\\bin to PATH (or set MTP_MONGODUMP_PATH etc.) and restart the terminal.',
      common,
    ];
  }
  if (platform === 'darwin') {
    return [
      'Install MongoDB Database Tools for macOS:',
      '  brew tap mongodb/brew && brew install mongodb-database-tools',
      common,
    ];
  }
  return [
    'Install MongoDB Database Tools for Linux:',
    '  Ubuntu/Debian: add the MongoDB apt repository, then: sudo apt-get install mongodb-database-tools',
    '  Fedora/RHEL:   add the MongoDB yum repository, then: sudo dnf install mongodb-database-tools',
    '  Or download the .deb/.rpm/.tgz from the page below and put the binaries on PATH.',
    common,
  ];
}

/**
 * Builds the URI handed to the tools: includes the username and TLS options but never the
 * password, which is passed via a private --config file instead of the process arguments.
 */
export function toolUri(profile: ConnectionProfile): string {
  const cs = new ConnectionString(profile.uri);
  cs.password = '';
  if (profile.username) cs.username = encodeURIComponent(profile.username);
  const params = cs.searchParams;
  if (profile.authSource) params.set('authSource', profile.authSource);
  if (profile.authMechanism) params.set('authMechanism', profile.authMechanism);
  if (profile.tls.mode === 'on') params.set('tls', 'true');
  if (profile.tls.mode === 'off') params.set('tls', 'false');
  if (profile.tls.caFile) params.set('tlsCAFile', profile.tls.caFile);
  if (profile.tls.certificateKeyFile) params.set('tlsCertificateKeyFile', profile.tls.certificateKeyFile);
  if (profile.tls.allowInvalidCertificates || profile.tls.allowInvalidHostnames)
    params.set('tlsInsecure', 'true');
  return cs.toString();
}

function yamlString(value: string): string {
  // YAML accepts JSON double-quoted scalars.
  return JSON.stringify(value);
}

/** Writes a temporary --config YAML file (mode 0600) and returns its path and a cleanup function. */
export async function writeToolConfig(
  profile: ConnectionProfile,
  password: string | undefined,
): Promise<{ file: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mtp-'));
  const file = path.join(dir, 'tools.yaml');
  const lines = [`uri: ${yamlString(toolUri(profile))}`];
  if (password !== undefined && password !== '') lines.push(`password: ${yamlString(password)}`);
  await fs.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return {
    file,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Max characters retained of each stream (tail). */
  keepChars?: number;
}

/** Spawns a process WITHOUT a shell. Arguments are passed as an array — no interpolation. */
export function runProcess(
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = options.keepChars ?? 64 * 1024;
    let stdout = '';
    let stderr = '';
    const pending: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' };
    const handle = (which: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (which === 'stdout') stdout = (stdout + text).slice(-keep);
      else stderr = (stderr + text).slice(-keep);
      if (options.onLine) {
        const lines = (pending[which] + text).split(/\r?\n/);
        pending[which] = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) options.onLine(redactText(l), which);
      }
    };
    child.stdout?.on('data', handle('stdout'));
    child.stderr?.on('data', handle('stderr'));
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs) timer = setTimeout(() => child.kill(), options.timeoutMs);
    const onAbort = () => child.kill();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      for (const which of ['stdout', 'stderr'] as const) {
        if (options.onLine && pending[which].trim()) options.onLine(redactText(pending[which]), which);
      }
      resolve({ code, signal, stdout: redactText(stdout), stderr: redactText(stderr) });
    });
  });
}

export function requireTool(name: ToolName): string {
  const p = locateTool(name);
  if (!p)
    throw new AppError(`${name} was not found on PATH`, 'TOOLS_MISSING', installInstructions().join('\n'));
  return p;
}
