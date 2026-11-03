import type { ConnectionManager } from '../connection/connection-manager.js';
import type { ServerInfo } from '../connection/connection-types.js';
import type { DatabaseListResult, DatabaseManager } from './database-manager.js';
import type {
  Availability,
  PoolConfiguration,
  ReplicaMember,
  ServerStatusSummary,
  StatisticsManager,
} from './statistics-manager.js';

export interface MonitoringSnapshot {
  takenAt: Date;
  pingMs?: number;
  connected: boolean;
  server?: ServerInfo;
  serverStatus: Availability<ServerStatusSummary>;
  replicaSet: Availability<{ set: string; members: ReplicaMember[] }>;
  pool: PoolConfiguration;
  databases?: DatabaseListResult;
  /** Operations per second computed between this and the previous snapshot. */
  opsPerSecond?: Record<string, number>;
}

/**
 * Collects monitoring snapshots on demand. Callers choose the refresh cadence; nothing polls in the
 * background unless the UI explicitly schedules it. These are statistics visible to this user via
 * supported commands — not a complete server-wide monitoring solution.
 */
export class MonitoringManager {
  private previous: MonitoringSnapshot | undefined;

  constructor(
    private readonly connection: ConnectionManager,
    private readonly stats: StatisticsManager,
    private readonly databases: DatabaseManager,
  ) {}

  async snapshot(options: { includeDatabases?: boolean } = {}): Promise<MonitoringSnapshot> {
    let pingMs: number | undefined;
    let connected = true;
    try {
      pingMs = await this.connection.ping();
    } catch {
      connected = false;
    }
    const [serverStatus, replicaSet, databases] = await Promise.all([
      this.stats.serverStatus(),
      this.connection.serverInfo?.topology === 'replica-set'
        ? this.stats.replicaSet()
        : Promise.resolve({ available: false, reason: 'Not a replica set' } as Availability<{
            set: string;
            members: ReplicaMember[];
          }>),
      options.includeDatabases
        ? this.databases.listWithStats(50).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    const snapshot: MonitoringSnapshot = {
      takenAt: new Date(),
      pingMs,
      connected,
      server: this.connection.serverInfo,
      serverStatus,
      replicaSet,
      pool: this.stats.poolConfiguration(),
      databases,
    };
    const prev = this.previous;
    const prevOps = prev?.serverStatus.data?.opcounters;
    const curOps = serverStatus.data?.opcounters;
    if (prev && prevOps && curOps) {
      const seconds = (snapshot.takenAt.getTime() - prev.takenAt.getTime()) / 1000;
      if (seconds > 0) {
        snapshot.opsPerSecond = Object.fromEntries(
          Object.entries(curOps).map(([k, v]) => [k, Math.max(0, (v - (prevOps[k] ?? v)) / seconds)]),
        );
      }
    }
    this.previous = snapshot;
    return snapshot;
  }
}
