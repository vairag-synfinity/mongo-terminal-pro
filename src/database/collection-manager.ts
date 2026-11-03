import type { CreateCollectionOptions, Document, MongoClient } from 'mongodb';
import { ValidationError } from '../core/error-handler.js';
import { Operations, type PermissionManager } from '../security/permission-manager.js';
import { validateCollectionName } from '../utils/validation.js';
import { isCommandNotFound, isUnauthorized, mapLimit } from './helpers.js';

export type CollectionType = 'collection' | 'view' | 'timeseries' | 'system';

export interface CollectionSummary {
  name: string;
  type: CollectionType;
  options: Document;
  readOnly: boolean;
  capped: boolean;
  /** Document count; `countIsEstimate` distinguishes metadata estimates from exact counts. */
  count?: number;
  countIsEstimate: boolean;
  size?: number;
  storageSize?: number;
  avgObjSize?: number;
  totalIndexSize?: number;
  indexCount?: number;
  statsError?: string;
}

export type CollectionSortKey = 'name' | 'count' | 'size' | 'indexes';

export interface CollectionStats {
  count: number;
  size: number;
  storageSize: number;
  avgObjSize: number;
  totalIndexSize: number;
  indexCount: number;
  indexSizes: Record<string, number>;
  capped: boolean;
}

export class CollectionManager {
  constructor(
    private readonly client: MongoClient,
    private readonly permissions: PermissionManager,
  ) {}

  /** Lists collections with metadata. Never scans documents. */
  async list(database: string, options: { withStats?: boolean } = {}): Promise<CollectionSummary[]> {
    const db = this.client.db(database);
    const infos = await db.listCollections({}, { nameOnly: false, authorizedCollections: true }).toArray(); // listCollections returns one entry per collection (bounded by namespace count).
    const collections: CollectionSummary[] = infos.map((info) => {
      const raw = info as { name: string; type?: string; options?: Document; info?: { readOnly?: boolean } };
      let type: CollectionType = 'collection';
      if (raw.type === 'view') type = 'view';
      else if (raw.type === 'timeseries') type = 'timeseries';
      else if (raw.name.startsWith('system.')) type = 'system';
      return {
        name: raw.name,
        type,
        options: raw.options ?? {},
        readOnly: Boolean(raw.info?.readOnly) || type === 'view',
        capped: Boolean(raw.options?.capped),
        countIsEstimate: true,
      };
    });
    collections.sort((a, b) => a.name.localeCompare(b.name));
    if (options.withStats) {
      await mapLimit(collections, 4, async (c) => {
        if (c.type === 'view') return; // counting a view executes its pipeline — skip.
        try {
          const stats = await this.stats(database, c.name);
          Object.assign(c, {
            count: stats.count,
            size: stats.size,
            storageSize: stats.storageSize,
            avgObjSize: stats.avgObjSize,
            totalIndexSize: stats.totalIndexSize,
            indexCount: stats.indexCount,
            capped: stats.capped || c.capped,
            countIsEstimate: true,
          });
        } catch (error) {
          c.statsError = isUnauthorized(error) ? 'not authorised' : (error as Error).message;
          try {
            c.count = await db.collection(c.name).estimatedDocumentCount({ maxTimeMS: 5000 });
          } catch {
            // leave unknown
          }
        }
      });
    }
    return collections;
  }

  /**
   * Storage statistics from metadata ($collStats storageStats, falling back to the legacy
   * collStats command on old servers). Counts here are metadata estimates.
   */
  async stats(database: string, collection: string): Promise<CollectionStats> {
    const coll = this.client.db(database).collection(collection);
    try {
      const cursor = coll.aggregate([{ $collStats: { storageStats: {} } }]);
      const docs: Document[] = [];
      // One document per shard; bounded.
      for await (const d of cursor) {
        docs.push(d);
        if (docs.length > 1000) break;
      }
      await cursor.close();
      const stats = docs.map((d) => (d.storageStats ?? {}) as Document);
      const sum = (key: string) => stats.reduce((acc, s) => acc + Number(s[key] ?? 0), 0);
      const indexSizes: Record<string, number> = {};
      for (const s of stats) {
        for (const [k, v] of Object.entries((s.indexSizes ?? {}) as Record<string, number>)) {
          indexSizes[k] = (indexSizes[k] ?? 0) + Number(v);
        }
      }
      const count = sum('count');
      const size = sum('size');
      return {
        count,
        size,
        storageSize: sum('storageSize'),
        avgObjSize: count > 0 ? size / count : 0,
        totalIndexSize: sum('totalIndexSize'),
        indexCount: Math.max(...stats.map((s) => Number(s.nindexes ?? 0)), 0),
        indexSizes,
        capped: stats.some((s) => Boolean(s.capped)),
      };
    } catch (error) {
      if (isUnauthorized(error)) throw error;
      if (!isCommandNotFound(error) && !/collStats|unrecognized|not allowed/i.test((error as Error).message))
        throw error;
    }
    const res = await this.client.db(database).command({ collStats: collection });
    return {
      count: Number(res.count ?? 0),
      size: Number(res.size ?? 0),
      storageSize: Number(res.storageSize ?? 0),
      avgObjSize: Number(res.avgObjSize ?? 0),
      totalIndexSize: Number(res.totalIndexSize ?? 0),
      indexCount: Number(res.nindexes ?? 0),
      indexSizes: (res.indexSizes ?? {}) as Record<string, number>,
      capped: Boolean(res.capped),
    };
  }

  /** Fast metadata-based count (O(1)); may be inaccurate after unclean shutdowns or on sharded clusters. */
  estimatedCount(database: string, collection: string): Promise<number> {
    return this.client.db(database).collection(collection).estimatedDocumentCount({ maxTimeMS: 10_000 });
  }

  /** Exact count; bounded by maxTimeMS because it may scan the collection or an index. */
  exactCount(database: string, collection: string, filter: Document = {}, maxTimeMS = 5000): Promise<number> {
    return this.client.db(database).collection(collection).countDocuments(filter, { maxTimeMS });
  }

  async create(database: string, name: string, options: CreateCollectionOptions = {}): Promise<void> {
    const error = validateCollectionName(name);
    if (error) throw new ValidationError(error);
    this.permissions.assert(Operations.createCollection);
    await this.client.db(database).createCollection(name, options);
  }

  async drop(database: string, name: string): Promise<boolean> {
    this.permissions.assert(Operations.dropCollection);
    return this.client.db(database).collection(name).drop();
  }

  async exists(database: string, name: string): Promise<boolean> {
    const found = await this.client.db(database).listCollections({ name }, { nameOnly: true }).toArray();
    return found.length > 0;
  }
}

export function filterAndSortCollections(
  collections: CollectionSummary[],
  options: { search?: string; sort?: CollectionSortKey; descending?: boolean; types?: CollectionType[] },
): CollectionSummary[] {
  const search = options.search?.trim().toLowerCase();
  let list = collections.filter((c) => (search ? c.name.toLowerCase().includes(search) : true));
  if (options.types && options.types.length > 0) list = list.filter((c) => options.types?.includes(c.type));
  const dir = options.descending ? -1 : 1;
  const key = options.sort ?? 'name';
  list = [...list].sort((a, b) => {
    switch (key) {
      case 'count':
        return ((a.count ?? -1) - (b.count ?? -1)) * dir;
      case 'size':
        return ((a.storageSize ?? -1) - (b.storageSize ?? -1)) * dir;
      case 'indexes':
        return ((a.indexCount ?? -1) - (b.indexCount ?? -1)) * dir;
      default:
        return a.name.localeCompare(b.name) * dir;
    }
  });
  return list;
}
