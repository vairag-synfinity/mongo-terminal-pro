import type { Document, MongoClient } from 'mongodb';
import { isUnauthorized } from './helpers.js';

export interface ReplicaMember {
  name: string;
  state: string;
  health: number;
  uptimeSeconds?: number;
  lagSeconds?: number;
  self: boolean;
}

export interface ServerStatusSummary {
  host?: string;
  version?: string;
  uptimeSeconds?: number;
  connections?: { current: number; available: number; totalCreated: number };
  opcounters?: Record<string, number>;
  memoryMB?: { resident?: number; virtual?: number };
  network?: { bytesIn: number; bytesOut: number; numRequests: number };
  storageEngine?: string;
}

export interface PoolConfiguration {
  maxPoolSize?: number;
  minPoolSize?: number;
  maxIdleTimeMS?: number;
  serverSelectionTimeoutMS?: number;
  connectTimeoutMS?: number;
  appName?: string;
}

export interface Availability<T> {
  available: boolean;
  data?: T;
  reason?: string;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (
    v &&
    typeof v === 'object' &&
    'toNumber' in v &&
    typeof (v as { toNumber: () => number }).toNumber === 'function'
  ) {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v ?? 0);
}

const REPLICA_STATES: Record<number, string> = {
  0: 'STARTUP',
  1: 'PRIMARY',
  2: 'SECONDARY',
  3: 'RECOVERING',
  5: 'STARTUP2',
  6: 'UNKNOWN',
  7: 'ARBITER',
  8: 'DOWN',
  9: 'ROLLBACK',
  10: 'REMOVED',
};

export class StatisticsManager {
  constructor(private readonly client: MongoClient) {}

  private async adminCommand(cmd: Document): Promise<Availability<Document>> {
    try {
      return { available: true, data: await this.client.db('admin').command(cmd) };
    } catch (error) {
      return {
        available: false,
        reason: isUnauthorized(error) ? 'Not authorised' : (error as Error).message,
      };
    }
  }

  /** serverStatus requires the clusterMonitor role; reported as unavailable otherwise. */
  async serverStatus(): Promise<Availability<ServerStatusSummary>> {
    const res = await this.adminCommand({
      serverStatus: 1,
      repl: 0,
      metrics: 0,
      locks: 0,
      wiredTiger: 0,
      tcmalloc: 0,
    });
    if (!res.available || !res.data) return { available: false, reason: res.reason };
    const s = res.data;
    const conn = s.connections as Document | undefined;
    const ops = s.opcounters as Document | undefined;
    const mem = s.mem as Document | undefined;
    const net = s.network as Document | undefined;
    return {
      available: true,
      data: {
        host: s.host as string | undefined,
        version: s.version as string | undefined,
        uptimeSeconds: toNumber(s.uptime),
        connections: conn
          ? {
              current: toNumber(conn.current),
              available: toNumber(conn.available),
              totalCreated: toNumber(conn.totalCreated),
            }
          : undefined,
        opcounters: ops
          ? Object.fromEntries(Object.entries(ops).map(([k, v]) => [k, toNumber(v)]))
          : undefined,
        memoryMB: mem ? { resident: toNumber(mem.resident), virtual: toNumber(mem.virtual) } : undefined,
        network: net
          ? {
              bytesIn: toNumber(net.bytesIn),
              bytesOut: toNumber(net.bytesOut),
              numRequests: toNumber(net.numRequests),
            }
          : undefined,
        storageEngine: (s.storageEngine as Document | undefined)?.name as string | undefined,
      },
    };
  }

  async replicaSet(): Promise<Availability<{ set: string; members: ReplicaMember[] }>> {
    const res = await this.adminCommand({ replSetGetStatus: 1 });
    if (!res.available || !res.data) return { available: false, reason: res.reason };
    const primary = (res.data.members as Document[]).find((m) => m.state === 1);
    const primaryOptime = primary?.optimeDate instanceof Date ? primary.optimeDate.getTime() : undefined;
    return {
      available: true,
      data: {
        set: String(res.data.set),
        members: (res.data.members as Document[]).map((m) => ({
          name: String(m.name),
          state: REPLICA_STATES[Number(m.state)] ?? String(m.stateStr ?? m.state),
          health: Number(m.health ?? 0),
          uptimeSeconds: m.uptime === undefined ? undefined : toNumber(m.uptime),
          lagSeconds:
            primaryOptime !== undefined && m.optimeDate instanceof Date
              ? Math.max(0, (primaryOptime - m.optimeDate.getTime()) / 1000)
              : undefined,
          self: Boolean(m.self),
        })),
      },
    };
  }

  /** Pool configuration as configured on this client (application-level, not server-wide). */
  poolConfiguration(): PoolConfiguration {
    const o = this.client.options as unknown as Record<string, unknown>;
    return {
      maxPoolSize: o.maxPoolSize as number | undefined,
      minPoolSize: o.minPoolSize as number | undefined,
      maxIdleTimeMS: o.maxIdleTimeMS as number | undefined,
      serverSelectionTimeoutMS: o.serverSelectionTimeoutMS as number | undefined,
      connectTimeoutMS: o.connectTimeoutMS as number | undefined,
      appName: o.appName as string | undefined,
    };
  }

  async shardingSummary(): Promise<Availability<{ shards: { id: string; host: string; state?: number }[] }>> {
    const res = await this.adminCommand({ listShards: 1 });
    if (!res.available || !res.data) return { available: false, reason: res.reason };
    return {
      available: true,
      data: {
        shards: ((res.data.shards ?? []) as Document[]).map((s) => ({
          id: String(s._id),
          host: String(s.host),
          state: s.state as number | undefined,
        })),
      },
    };
  }
}
