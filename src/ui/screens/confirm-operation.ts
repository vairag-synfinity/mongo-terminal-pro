import type { Application } from '../../core/application.js';
import type { NotificationLevel } from '../../core/application-state.js';
import type { OperationDescriptor } from '../../security/permission-manager.js';
import type { ConfirmOptions } from '../components/dialog.js';

interface Deps {
  app: Application;
  dialog: { confirm(o: ConfirmOptions): Promise<boolean> };
  notify(level: NotificationLevel, title: string, message?: string): void;
}

/**
 * Applies the permission policy before a write: blocks in read-only mode (with a hint to press W),
 * asks for confirmation or a typed connection name as required. Returns true to proceed.
 */
export async function confirmOperation(
  deps: Deps,
  op: OperationDescriptor,
  detail: string,
  extra: string[] = [],
  forceConfirm = false,
): Promise<boolean> {
  const decision = deps.app.permissions.check(op);
  if (!decision.allowed) {
    deps.notify('warning', 'Read-only session', decision.reason);
    return false;
  }
  const kind = decision.confirmation === 'none' && forceConfirm ? 'confirm' : decision.confirmation;
  if (kind === 'none') return true;
  const name = deps.app.permissions.connectionName ?? '';
  return deps.dialog.confirm({
    title: op.name,
    message: [
      detail,
      ...extra,
      ...(deps.app.permissions.isProduction ? [`Connection "${name}" is marked as PRODUCTION.`] : []),
    ],
    confirmLabel: op.risk === 'destructive' ? 'Yes, proceed' : 'Proceed',
    danger: op.risk === 'destructive' || deps.app.permissions.isProduction,
    typeToConfirm: kind === 'type-name' ? name : undefined,
  });
}
