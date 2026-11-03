/**
 * Framework-agnostic observable state shared by the TUI (via useSyncExternalStore) and services.
 */

export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

export interface Notification {
  id: number;
  level: NotificationLevel;
  title: string;
  message?: string;
  createdAt: number;
}

export interface ApplicationStateShape {
  connectionId?: string;
  connectionName?: string;
  connected: boolean;
  writeEnabled: boolean;
  production: boolean;
  readOnlyLocked: boolean;
  database?: string;
  collection?: string;
  notifications: Notification[];
}

type Listener = () => void;

export class ApplicationState {
  private state: ApplicationStateShape = {
    connected: false,
    writeEnabled: false,
    production: false,
    readOnlyLocked: false,
    notifications: [],
  };
  private readonly listeners = new Set<Listener>();
  private nextId = 1;

  getSnapshot = (): ApplicationStateShape => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<ApplicationStateShape>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  notify(level: NotificationLevel, title: string, message?: string): number {
    const id = this.nextId++;
    const notifications = [
      ...this.state.notifications,
      { id, level, title, message, createdAt: Date.now() },
    ].slice(-5);
    this.set({ notifications });
    return id;
  }

  dismiss(id: number): void {
    this.set({ notifications: this.state.notifications.filter((n) => n.id !== id) });
  }

  clearNotifications(): void {
    this.set({ notifications: [] });
  }
}
