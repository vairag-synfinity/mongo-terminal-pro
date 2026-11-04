import type { Command } from 'commander';
import ora from 'ora';
import type { Application } from '../core/application.js';
import type { TransferProgress } from '../transfer/transfer-progress.js';
import { formatBytes, formatNumber } from '../utils/formatting.js';
import { connectResolved, isInteractive, resolveConnection } from './session.js';

/** Helpers shared by CLI command modules. */

export type AppFactory = () => Promise<Application>;

export interface GlobalOpts {
  connection?: string;
}

export function globals(cmd: Command): GlobalOpts {
  return cmd.optsWithGlobals() as GlobalOpts;
}

export async function withConnection<T>(app: Application, cmd: Command, fn: () => Promise<T>): Promise<T> {
  const resolved = await resolveConnection(app, globals(cmd).connection);
  const spinner = isInteractive()
    ? ora({ text: `Connecting to ${resolved.profile.name}…`, stream: process.stderr }).start()
    : undefined;
  try {
    await connectResolved(app, resolved);
    spinner?.stop();
  } catch (error) {
    spinner?.fail(`Could not connect to ${resolved.profile.name}`);
    throw error;
  }
  return fn();
}

export function progressText(p: TransferProgress): string {
  const total = p.total !== undefined ? `/${p.totalIsEstimate ? '~' : ''}${formatNumber(p.total)}` : '';
  const bytes = p.totalBytes
    ? ` ${formatBytes(p.bytes)}/${formatBytes(p.totalBytes)}`
    : p.bytes
      ? ` ${formatBytes(p.bytes)}`
      : '';
  return `${p.phase} ${formatNumber(p.processed)}${total}${bytes}${p.current ? ` · ${p.current}` : ''}`;
}
