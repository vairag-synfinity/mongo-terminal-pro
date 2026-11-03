import type { MongoClient } from 'mongodb';
import { ValidationError } from '../core/error-handler.js';
import { Operations, type PermissionManager } from '../security/permission-manager.js';
import { validateCollectionName, validateDatabaseName } from '../utils/validation.js';
import { isUnauthorized, mapLimit } from './helpers.js';

export interface DatabaseStats {
  collections: number;
  views: number;
  objects: number;
  avgObjSize: number;
  dataSize: number;
  storageSize: number;
  indexes: number;
  indexSize: number;
  totalSize?: number;
}

export interface DatabaseSummary {
  name: string;
  sizeOnDisk?: number;
  empty?: boolean;
  stats?: DatabaseStats;
  statsError?: string;
}

export interface DatabaseListResult {
  databases: DatabaseSummary[];
  totalSize?: number;
  /** How the list was obtained; 'restricted' means the user lacks listDatabases privilege. */
  mode: 'full' | 'authorized' | 'restricted';
  warning?: string;
}

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);

export function isSystemDatabase(name: string): boolean {
  return SYSTEM_DATABASES.has(name);
}

export class DatabaseManager {
  constructor(
    private readonly client: MongoClient,
    private readonly permissions: PermissionManager,
    private readonly fallbackDatabase?: string,
  ) {}

  /** Lists databases the authenticated user may access, using metadata only. */
  async list(): Promise<DatabaseListResult> {
    const admin = this.client.db('admin');
    try {
      const res = await admin.command({ listDatabases: 1, authorizedDatabases: true });
      const dbs = (res.databases as { name: string; sizeOnDisk?: number; empty?: boolean }[]).map((d) => ({
        name: d.name,
        sizeOnDisk: d.sizeOnDisk,
        empty: d.empty,
      }));
      return { databases: sortDatabases(dbs), totalSize: res.totalSize as number | undefined, mode: 'full' };
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
    }
    try {
      const res = await admin.command({ listDatabases: 1, nameOnly: true, authorizedDatabases: true });
      const dbs = (res.databases as { name: string }[]).map((d) => ({ name: d.name }));
      return { databases: sortDatabases(dbs), mode: 'authorized' };
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
    }
    const fallback = this.fallbackDatabase;
    return {
      databases: fallback ? [{ name: fallback }] : [],
      mode: 'restricted',
      warning: fallback
        ? 'Your user cannot list databases; showing the connection default database only.'
        : 'Your user cannot list databases. Set a default database on the connection to browse it.',
    };
  }

  async stats(name: string): Promise<DatabaseStats> {
    const res = await this.client.db(name).command({ dbStats: 1, scale: 1 });
    return {
      collections: Number(res.collections ?? 0),
      views: Number(res.views ?? 0),
      objects: Number(res.objects ?? 0),
      avgObjSize: Number(res.avgObjSize ?? 0),
      dataSize: Number(res.dataSize ?? 0),
      storageSize: Number(res.storageSize ?? 0),
      indexes: Number(res.indexes ?? 0),
      indexSize: Number(res.indexSize ?? 0),
      totalSize: res.totalSize === undefined ? undefined : Number(res.totalSize),
    };
  }

  /** Lists databases and fetches dbStats for each with bounded concurrency. */
  async listWithStats(maxStats = 100): Promise<DatabaseListResult> {
    const result = await this.list();
    const targets = result.databases.slice(0, maxStats);
    await mapLimit(targets, 4, async (db) => {
      try {
        db.stats = await this.stats(db.name);
      } catch (error) {
        db.statsError = isUnauthorized(error) ? 'not authorised' : (error as Error).message;
      }
    });
    return result;
  }

  /** MongoDB creates a database implicitly with its first collection. */
  async create(name: string, firstCollection: string): Promise<void> {
    const dbError = validateDatabaseName(name);
    if (dbError) throw new ValidationError(dbError);
    const collError = validateCollectionName(firstCollection);
    if (collError) throw new ValidationError(collError);
    this.permissions.assert(Operations.createCollection);
    await this.client.db(name).createCollection(firstCollection);
  }

  async drop(name: string): Promise<void> {
    this.permissions.assert(Operations.dropDatabase);
    if (isSystemDatabase(name)) throw new ValidationError(`Refusing to drop system database "${name}"`);
    await this.client.db(name).dropDatabase();
  }
}

function sortDatabases<T extends { name: string }>(dbs: T[]): T[] {
  return [...dbs].sort((a, b) => {
    const sa = isSystemDatabase(a.name);
    const sb = isSystemDatabase(b.name);
    if (sa !== sb) return sa ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}
