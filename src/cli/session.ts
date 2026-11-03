import { confirm, input, password as passwordPrompt } from '@inquirer/prompts';
import { randomUUID } from 'node:crypto';
import { needsPassword } from '../connection/connection-manager.js';
import { ConnectionProfileSchema, type ConnectionProfile } from '../connection/connection-types.js';
import { detectKind, stripCredentials } from '../connection/manual-connection.js';
import type { Application } from '../core/application.js';
import { AppError } from '../core/error-handler.js';
import type { ConfirmationKind, OperationDescriptor } from '../security/permission-manager.js';
import { c } from './output.js';

export interface ResolvedConnection {
  profile: ConnectionProfile;
  password?: string;
  /** True when the profile comes from MTP_URI and is not saved. */
  ephemeral: boolean;
}

export const isInteractive = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * Resolves which connection a CLI command uses:
 *   1. --connection <name|id>
 *   2. MTP_URI environment variable (ad-hoc, not saved)
 *   3. the default saved connection
 * Passwords: credential store → MTP_PASSWORD → interactive prompt. Never from argv.
 */
export async function resolveConnection(
  app: Application,
  name: string | undefined,
): Promise<ResolvedConnection> {
  let profile: ConnectionProfile | undefined;
  let password: string | undefined;
  let ephemeral = false;
  if (name) {
    profile = await app.connections.findByName(name);
    if (!profile)
      throw new AppError(
        `No saved connection named "${name}"`,
        'NOT_FOUND',
        'Run "mongo-terminal connections list" to see saved connections.',
      );
  } else if (process.env.MTP_URI) {
    const normalized = stripCredentials(process.env.MTP_URI);
    const now = new Date().toISOString();
    profile = ConnectionProfileSchema.parse({
      id: `env-${randomUUID()}`,
      name: 'MTP_URI',
      kind: detectKind(normalized.uri),
      uri: normalized.uri,
      username: normalized.username,
      authSource: normalized.authSource,
      authMechanism: normalized.authMechanism,
      defaultDatabase: normalized.defaultDatabase,
      production: process.env.MTP_PRODUCTION === '1',
      source: 'cli',
      createdAt: now,
      updatedAt: now,
    });
    password = normalized.password;
    ephemeral = true;
  } else {
    profile = await app.connections.getDefault();
    if (!profile) {
      throw new AppError(
        'No connection selected',
        'NOT_CONNECTED',
        'Use --connection <name>, set a default connection, or add one with "mongo-terminal connections add".',
      );
    }
  }
  if (profile.username && needsPassword(profile) && password === undefined) {
    if (!ephemeral) password = await app.connections.getPassword(profile.id).catch(() => undefined);
    password ??= process.env.MTP_PASSWORD;
    if (password === undefined) {
      if (!isInteractive()) {
        throw new AppError(
          `Password required for "${profile.name}"`,
          'AUTH',
          'Store it with "connections add --save-password", or set MTP_PASSWORD for non-interactive use.',
        );
      }
      password = await passwordPrompt({
        message: `Password for ${profile.username}@${profile.name}:`,
        mask: '*',
      });
    }
  }
  return { profile, password, ephemeral };
}

export async function connectResolved(app: Application, resolved: ResolvedConnection): Promise<void> {
  await app.connect(resolved.profile, resolved.password);
}

/**
 * Enables write access for a CLI invocation. Requires the --write flag; production connections
 * additionally require typing the connection name (or --confirm <name> when non-interactive).
 */
export async function enableCliWrites(
  app: Application,
  opts: { write?: boolean; confirm?: string },
  purpose: string,
): Promise<void> {
  if (!opts.write) {
    throw new AppError(
      `${purpose} modifies data, and sessions are read-only by default.`,
      'READ_ONLY',
      'Re-run with --write to explicitly enable write access.',
    );
  }
  const req = app.permissions.enableWriteRequirement();
  if (!req.allowed) throw new AppError(req.reason ?? 'Write access cannot be enabled', 'READ_ONLY');
  if (req.confirmation === 'type-name') {
    const name = app.permissions.connectionName ?? '';
    let typed = opts.confirm;
    if (typed === undefined) {
      if (!isInteractive())
        throw new AppError(
          `"${name}" is a production connection.`,
          'READ_ONLY',
          `Pass --confirm "${name}" to confirm in non-interactive mode.`,
        );
      console.error(c.red.bold(`PRODUCTION connection "${name}". ${purpose} will modify data.`));
      typed = await input({ message: `Type the connection name to enable write access:` });
    }
    app.enableWrites(typed);
  } else {
    app.enableWrites();
  }
}

/** Confirms an individual operation according to the permission policy. */
export async function confirmOperation(
  app: Application,
  op: OperationDescriptor,
  detail: string,
  opts: { yes?: boolean; confirm?: string },
): Promise<void> {
  const decision = app.permissions.check(op);
  if (!decision.allowed) throw new AppError(decision.reason ?? `${op.name} is not permitted`, 'READ_ONLY');
  await confirmKind(app, decision.confirmation, `${op.name}: ${detail}`, opts);
}

export async function confirmKind(
  app: Application,
  kind: ConfirmationKind,
  message: string,
  opts: { yes?: boolean; confirm?: string },
): Promise<void> {
  if (kind === 'none') return;
  const name = app.permissions.connectionName ?? '';
  if (kind === 'type-name') {
    if (opts.confirm !== undefined) {
      if (opts.confirm !== name)
        throw new AppError('Confirmation failed: connection name did not match', 'CANCELLED');
      return;
    }
    if (!isInteractive())
      throw new AppError(`${message} requires confirmation`, 'CANCELLED', `Pass --confirm "${name}".`);
    const typed = await input({ message: `${c.red(message)}\nType "${name}" to confirm:` });
    if (typed !== name) throw new AppError('Confirmation failed: connection name did not match', 'CANCELLED');
    return;
  }
  if (opts.yes || (opts.confirm !== undefined && opts.confirm === name)) return;
  if (!isInteractive())
    throw new AppError(
      `${message} requires confirmation`,
      'CANCELLED',
      'Pass --yes to confirm in non-interactive mode.',
    );
  const ok = await confirm({ message: `${message}. Continue?`, default: false });
  if (!ok) throw new AppError('Cancelled by user', 'CANCELLED');
}
