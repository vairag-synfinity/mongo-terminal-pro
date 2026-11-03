import { spawn } from 'node:child_process';
import { findExecutable, getPlatformInfo } from './platform.js';

export interface ClipboardResult {
  ok: boolean;
  method?: string;
  reason?: string;
}

function pipeTo(command: string, args: string[], text: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.end(text);
    } catch {
      resolve(false);
    }
  });
}

/** OSC 52 sets the clipboard through the terminal itself — works over SSH in supporting terminals. */
export function osc52Sequence(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const seq = `\u001B]52;c;${b64}\u0007`;
  // tmux/screen need passthrough wrapping.
  if (process.env.TMUX) return `\u001BPtmux;\u001B${seq}\u001B\\`;
  return seq;
}

/**
 * Copies text using the native clipboard tool when available (pbcopy, clip/PowerShell, wl-copy,
 * xclip, xsel) and additionally emits OSC 52 in SSH sessions. No shell is involved.
 */
export async function copyToClipboard(
  text: string,
  stream: NodeJS.WriteStream = process.stdout,
): Promise<ClipboardResult> {
  const info = getPlatformInfo();
  const candidates: [string, string[]][] = [];
  if (info.isMac) candidates.push(['pbcopy', []]);
  else if (info.isWindows || info.isWSL) {
    candidates.push(
      ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$input | Set-Clipboard']],
      ['clip.exe', []],
    );
  }
  if (info.isLinux) {
    if (process.env.WAYLAND_DISPLAY) candidates.push(['wl-copy', []]);
    if (process.env.DISPLAY)
      candidates.push(['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]);
  }
  if (!info.isSSH) {
    for (const [cmd, args] of candidates) {
      const resolved = findExecutable(cmd);
      if (!resolved) continue;
      if (await pipeTo(resolved, args, text)) return { ok: true, method: cmd };
    }
  }
  if (stream.isTTY && Buffer.byteLength(text) < 100_000) {
    stream.write(osc52Sequence(text));
    return { ok: true, method: 'OSC 52 (terminal clipboard; requires terminal support)' };
  }
  return {
    ok: false,
    reason: 'No clipboard tool found (install xclip/wl-clipboard) and OSC 52 is unavailable',
  };
}
