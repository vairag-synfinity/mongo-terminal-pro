import { ConfigurationManager, HistoryManager } from '../config/configuration.js';
import type { Settings } from '../config/defaults.js';
import { getAppPaths, type AppPaths } from '../config/paths.js';
import { ConnectionManager } from '../connection/connection-manager.js';
import { ConnectionStorage } from '../connection/connection-storage.js';
import type { ConnectionProfile, ServerInfo } from '../connection/connection-types.js';
import { BackupHistory } from '../backup/backup-history.js';
import { DatabaseServices } from '../database/database-services.js';
import { MonitoringManager } from '../database/monitoring-manager.js';
import { CredentialManager } from '../security/credential-manager.js';
import { PermissionManager } from '../security/permission-manager.js';
import { ApplicationState } from './application-state.js';
import { AppError } from './error-handler.js';
import { EventManager } from './event-manager.js';
import { createLogger, type Logger } from './logger.js';

export interface ApplicationOptions {
  paths?: AppPaths;
  /** Disable file logging (tests, --no-log). */
  logging?: boolean;
}

/**
 * Composition root. Creates every long-lived service once and wires them together. Both the
 * interactive TUI and the non-interactive CLI commands use this.
 */
export class Application {
  readonly paths: AppPaths;
  readonly events = new EventManager();
  readonly state = new ApplicationState();
  readonly config: ConfigurationManager;
  readonly history: HistoryManager;
  readonly credentials: CredentialManager;
  readonly connections: ConnectionStorage;
  readonly connectionManager: ConnectionManager;
  readonly permissions = new PermissionManager();
  readonly backupHistory: BackupHistory;
  logger: Logger;
  private dbServices: DatabaseServices | undefined;
  private monitor: MonitoringManager | undefined;

  private constructor(paths: AppPaths, logger: Logger) {
    this.paths = paths;
    this.logger = logger;
    this.config = new ConfigurationManager(paths);
    this.history = new HistoryManager(paths, async () => (await this.config.get()).historyLimit);
    this.credentials = new CredentialManager(paths, async () => (await this.config.get()).credentialStorage);
    this.connections = new ConnectionStorage(paths, this.credentials);
    this.connectionManager = new ConnectionManager(this.events, logger, async () => {
      const s = await this.config.get();
      return { connectTimeoutMs: s.connectTimeoutMs, maxPoolSize: s.maxPoolSize };
    });
    this.backupHistory = new BackupHistory(paths);
  }

  static async create(options: ApplicationOptions = {}): Promise<Application> {
    const paths = options.paths ?? getAppPaths();
    const bootstrap = new Application(paths, createLogger(undefined, 'silent'));
    const settings = await bootstrap.config.get();
    if (options.logging !== false) {
      bootstrap.logger = createLogger(paths.logFile, settings.logLevel);
    }
    bootstrap.logger.info({ platform: process.platform, node: process.version }, 'application started');
    return bootstrap;
  }

  settings(): Promise<Settings> {
    return this.config.get();
  }

  /** Connects to a saved profile and resets the session to read-only. */
  async connect(profile: ConnectionProfile, password?: string): Promise<ServerInfo> {
    const pass = password ?? (profile.username ? await this.connections.getPassword(profile.id) : undefined);
    const server = await this.connectionManager.connect(profile, pass);
    if (password !== undefined) this.credentials.rememberForSession(profile.id, password);
    this.permissions.setProfile(profile);
    this.dbServices = undefined;
    this.monitor = undefined;
    await this.connections.markUsed(profile.id).catch(() => undefined);
    this.state.set({
      connected: true,
      connectionId: profile.id,
      connectionName: profile.name,
      writeEnabled: false,
      production: profile.production,
      readOnlyLocked: profile.readOnlyLocked,
      database: profile.defaultDatabase,
      collection: undefined,
    });
    return server;
  }

  async disconnect(): Promise<void> {
    await this.connectionManager.disconnect();
    this.permissions.setProfile(undefined);
    this.dbServices = undefined;
    this.monitor = undefined;
    this.state.set({
      connected: false,
      connectionId: undefined,
      connectionName: undefined,
      writeEnabled: false,
      database: undefined,
      collection: undefined,
    });
  }

  /** Services bound to the active connection. */
  db(): DatabaseServices {
    if (!this.connectionManager.isConnected) {
      throw new AppError(
        'No active connection',
        'NOT_CONNECTED',
        'Connect to a server from the Connection Manager first.',
      );
    }
    this.dbServices ??= new DatabaseServices(
      this.connectionManager.getClient(),
      this.permissions,
      () => this.config.get(),
      this.logger,
      this.connectionManager.activeProfile?.defaultDatabase,
    );
    return this.dbServices;
  }

  monitoring(): MonitoringManager {
    const db = this.db();
    this.monitor ??= new MonitoringManager(this.connectionManager, db.statistics, db.databases);
    return this.monitor;
  }

  enableWrites(typedName?: string): void {
    this.permissions.enableWrites(typedName);
    this.state.set({ writeEnabled: true });
    this.events.emit('permissions:changed', { writeEnabled: true });
    this.logger.info({ connection: this.permissions.connectionName }, 'write access enabled');
  }

  disableWrites(): void {
    this.permissions.disableWrites();
    this.state.set({ writeEnabled: false });
    this.events.emit('permissions:changed', { writeEnabled: false });
  }

  async shutdown(): Promise<void> {
    await this.connectionManager.disconnect().catch(() => undefined);
    this.events.removeAll();
    try {
      // The async file destination may not be open yet in very short CLI runs.
      this.logger.flush?.();
    } catch {
      // Ignore: pino flushes on exit anyway.
    }
  }
}
