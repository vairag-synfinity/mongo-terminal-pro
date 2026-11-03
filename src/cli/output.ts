import { Chalk, type ChalkInstance } from 'chalk';
import Table from 'cli-table3';
import { detectColorLevel, detectUnicode } from '../utils/terminal.js';

let colorEnabled = detectColorLevel(process.env, Boolean(process.stdout.isTTY)) > 0;

export function setColor(enabled: boolean): void {
  colorEnabled = enabled;
  c = new Chalk({ level: enabled ? (Math.max(1, detectColorLevel(process.env, true)) as 1 | 2 | 3) : 0 });
}

export let c: ChalkInstance = new Chalk({
  level: colorEnabled ? (detectColorLevel(process.env, Boolean(process.stdout.isTTY)) as 0 | 1 | 2 | 3) : 0,
});

export const sym = () => {
  const u = detectUnicode();
  return {
    ok: u ? '✔' : 'OK',
    fail: u ? '✖' : 'X',
    warn: u ? '⚠' : '!',
    info: u ? 'ℹ' : 'i',
    dot: u ? '●' : '*',
    arrow: u ? '→' : '->',
  };
};

export function table(
  head: string[],
  rows: (string | number)[][],
  options: { colAligns?: ('left' | 'right' | 'center')[] } = {},
): string {
  const unicode = detectUnicode();
  const t = new Table({
    head: head.map((h) => c.bold.cyan(h)),
    // cli-table3 merges options shallowly: passing `undefined` would replace its defaults.
    ...(options.colAligns ? { colAligns: options.colAligns } : {}),
    style: { head: [], border: colorEnabled ? ['gray'] : [] },
    ...(unicode
      ? {}
      : {
          chars: {
            top: '-',
            'top-mid': '+',
            'top-left': '+',
            'top-right': '+',
            bottom: '-',
            'bottom-mid': '+',
            'bottom-left': '+',
            'bottom-right': '+',
            left: '|',
            'left-mid': '+',
            mid: '-',
            'mid-mid': '+',
            right: '|',
            'right-mid': '+',
            middle: '|',
          },
        }),
  });
  for (const r of rows) t.push(r.map((v) => String(v)));
  return t.toString();
}

export function success(msg: string): void {
  console.log(`${c.green(sym().ok)} ${msg}`);
}
export function warn(msg: string): void {
  console.error(`${c.yellow(sym().warn)} ${msg}`);
}
export function info(msg: string): void {
  console.log(`${c.blue(sym().info)} ${msg}`);
}
export function fail(msg: string): void {
  console.error(`${c.red(sym().fail)} ${msg}`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
