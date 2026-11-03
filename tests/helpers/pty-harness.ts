import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import xterm from '@xterm/headless';

const { Terminal } = xterm;

/**
 * Runs the real CLI inside a pseudo-terminal (via util-linux / BSD `script`) and feeds the output
 * into a headless xterm emulator, so tests can assert on what a user would actually see.
 * POSIX only — on Windows the TUI is covered by component tests.
 */
export class PtySession {
  private readonly term;
  private readonly child: ChildProcess;
  private exited: Promise<number | null>;
  output = '';

  constructor(args: string[], options: { cols?: number; rows?: number; env?: NodeJS.ProcessEnv } = {}) {
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 36;
    this.term = new Terminal({ cols, rows, allowProposedApi: true });
    const bin = path.resolve('dist/cli/bin.js');
    const quoted = [process.execPath, bin, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const command = `stty cols ${cols} rows ${rows}; exec ${quoted}`;
    const scriptArgs =
      process.platform === 'darwin'
        ? ['-q', '/dev/null', 'sh', '-c', command]
        : ['-qfec', command, '/dev/null'];
    this.child = spawn('script', scriptArgs, {
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
        FORCE_COLOR: undefined,
        NO_COLOR: undefined,
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout?.on('data', (d: Buffer) => {
      const text = d.toString('utf8');
      this.output += text;
      this.term.write(text);
    });
    this.child.stderr?.on('data', (d: Buffer) => {
      this.output += d.toString('utf8');
    });
    this.exited = new Promise((resolve) => this.child.on('close', (code) => resolve(code)));
  }

  /** Current screen contents as plain text lines. */
  screen(): string {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < this.term.rows; i++)
      lines.push(buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }

  async waitFor(
    predicate: string | RegExp | ((screen: string) => boolean),
    timeoutMs = 15_000,
  ): Promise<string> {
    const test =
      typeof predicate === 'function'
        ? predicate
        : (s: string) => (typeof predicate === 'string' ? s.includes(predicate) : predicate.test(s));
    const started = Date.now();
    for (;;) {
      await new Promise<void>((r) => this.term.write('', () => r()));
      const s = this.screen();
      if (test(s)) return s;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for ${String(predicate)}.\n--- screen ---\n${s}\n--- end ---`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  write(keys: string): void {
    this.child.stdin?.write(keys);
  }

  /** Sends keys one at a time (like a person typing) and waits for the UI to settle. */
  async press(keys: string | string[], settleMs = 250): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      this.write(k);
      await new Promise((r) => setTimeout(r, 40));
    }
    await new Promise((r) => setTimeout(r, settleMs));
  }

  /** Types text character by character. */
  async type(text: string, settleMs = 200): Promise<void> {
    await this.press([...text], settleMs);
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  async exit(timeoutMs = 10_000): Promise<number | null> {
    const timer = setTimeout(() => this.child.kill('SIGKILL'), timeoutMs);
    const code = await this.exited;
    clearTimeout(timer);
    return code;
  }

  kill(): void {
    this.child.kill('SIGKILL');
  }
}

export const KEYS = {
  up: '\u001B[A',
  down: '\u001B[B',
  right: '\u001B[C',
  left: '\u001B[D',
  enter: '\r',
  esc: '\u001B',
  tab: '\t',
  backspace: '\u007F',
  ctrlC: '\u0003',
  ctrlS: '\u0013',
  ctrlR: '\u0012',
  pageDown: '\u001B[6~',
};
