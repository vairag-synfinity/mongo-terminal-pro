import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Splits an EDITOR value like `code --wait` or `"C:\Program Files\Notepad++\notepad++.exe" -multiInst` without a shell. */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (current) parts.push(current);
      current = '';
    } else current += ch;
  }
  if (current) parts.push(current);
  return parts;
}

export function resolveEditor(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const value = env.MTP_EDITOR || env.VISUAL || env.EDITOR;
  if (value) return splitCommand(value);
  if (process.platform === 'win32') return ['notepad.exe'];
  return undefined;
}

/**
 * Edits text in the user's editor ($VISUAL/$EDITOR). The caller must suspend the TUI first.
 * The temporary file is private (0600) and removed afterwards.
 */
export async function editInExternalEditor(
  initial: string,
  extension = '.json',
): Promise<string | undefined> {
  const editor = resolveEditor();
  if (!editor || editor.length === 0) return undefined;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mtp-edit-'));
  const file = path.join(dir, `document${extension}`);
  await fs.writeFile(file, initial, { mode: 0o600 });
  try {
    const [cmd, ...args] = editor as [string, ...string[]];
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(cmd, [...args, file], { stdio: 'inherit', shell: false });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) return undefined;
    return await fs.readFile(file, 'utf8');
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
