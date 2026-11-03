import type { ConnectionProfile } from '../connection/connection-types.js';
import { ReadOnlyError } from '../core/error-handler.js';

/**
 * Access policy.
 *
 * - Every session starts READ-ONLY. Writes require the user to explicitly enable write access.
 * - Profiles with `readOnlyLocked` can never enable writes.
 * - Production profiles require typing the connection name to enable writes and to confirm
 *   destructive operations.
 * - Destructive operations (drop, delete, restore --drop, …) always require confirmation.
 */

export type OperationRisk = 'read' | 'write' | 'destructive';

export type ConfirmationKind = 'none' | 'confirm' | 'type-name';

export interface OperationDescriptor {
  name: string;
  risk: OperationRisk;
}

export const Operations = {
  insertDocument: { name: 'Insert document', risk: 'write' },
  updateDocument: { name: 'Update document', risk: 'write' },
  duplicateDocument: { name: 'Duplicate document', risk: 'write' },
  deleteDocument: { name: 'Delete document', risk: 'destructive' },
  updateMany: { name: 'Update many documents', risk: 'destructive' },
  deleteMany: { name: 'Delete many documents', risk: 'destructive' },
  createCollection: { name: 'Create collection', risk: 'write' },
  dropCollection: { name: 'Drop collection', risk: 'destructive' },
  dropDatabase: { name: 'Drop database', risk: 'destructive' },
  createIndex: { name: 'Create index', risk: 'write' },
  dropIndex: { name: 'Drop index', risk: 'destructive' },
  importInsert: { name: 'Import documents', risk: 'write' },
  importUpsert: { name: 'Import with upsert (may replace existing documents)', risk: 'destructive' },
  aggregationWrite: { name: 'Aggregation with $out/$merge', risk: 'destructive' },
  restore: { name: 'Restore backup', risk: 'write' },
  restoreDrop: { name: 'Restore backup dropping existing collections', risk: 'destructive' },
} as const satisfies Record<string, OperationDescriptor>;

export interface PermissionDecision {
  allowed: boolean;
  reason?: string;
  confirmation: ConfirmationKind;
}

export class PermissionManager {
  private writeEnabled = false;

  constructor(private profile: ConnectionProfile | undefined = undefined) {}

  setProfile(profile: ConnectionProfile | undefined): void {
    this.profile = profile;
    // Switching connections always drops back to read-only.
    this.writeEnabled = false;
  }

  get isWriteEnabled(): boolean {
    return this.writeEnabled;
  }

  get isProduction(): boolean {
    return Boolean(this.profile?.production);
  }

  get connectionName(): string | undefined {
    return this.profile?.name;
  }

  /** What is required to enable write access for the current connection. */
  enableWriteRequirement(): PermissionDecision {
    if (!this.profile) return { allowed: false, reason: 'Not connected', confirmation: 'none' };
    if (this.profile.readOnlyLocked) {
      return {
        allowed: false,
        reason: `Connection "${this.profile.name}" is locked read-only. Edit the connection to unlock it.`,
        confirmation: 'none',
      };
    }
    return { allowed: true, confirmation: this.profile.production ? 'type-name' : 'confirm' };
  }

  /**
   * Enables writes. Callers must have obtained the confirmation described by
   * `enableWriteRequirement()`; for production connections the typed name is verified here.
   */
  enableWrites(typedName?: string): void {
    const req = this.enableWriteRequirement();
    if (!req.allowed) throw new ReadOnlyError(req.reason ?? 'Write access cannot be enabled');
    if (req.confirmation === 'type-name' && typedName !== this.profile?.name) {
      throw new ReadOnlyError('Confirmation failed: the connection name did not match.');
    }
    this.writeEnabled = true;
  }

  disableWrites(): void {
    this.writeEnabled = false;
  }

  check(op: OperationDescriptor): PermissionDecision {
    if (op.risk === 'read') return { allowed: true, confirmation: 'none' };
    if (!this.profile) return { allowed: false, reason: 'Not connected', confirmation: 'none' };
    if (this.profile.readOnlyLocked) {
      return { allowed: false, reason: `"${this.profile.name}" is locked read-only.`, confirmation: 'none' };
    }
    if (!this.writeEnabled) {
      return {
        allowed: false,
        reason: `${op.name} requires write access. The session is read-only — enable write access first (press W).`,
        confirmation: 'none',
      };
    }
    if (op.risk === 'destructive') {
      return { allowed: true, confirmation: this.profile.production ? 'type-name' : 'confirm' };
    }
    return { allowed: true, confirmation: this.profile.production ? 'confirm' : 'none' };
  }

  /** Throws if the operation is not permitted. Used by services as a last line of defence. */
  assert(op: OperationDescriptor): void {
    const decision = this.check(op);
    if (!decision.allowed) throw new ReadOnlyError(decision.reason ?? `${op.name} is not permitted`);
  }

  /** Verifies a type-to-confirm answer for the current connection. */
  verifyTypedConfirmation(typed: string): boolean {
    return Boolean(this.profile) && typed.trim() === this.profile?.name;
  }
}
