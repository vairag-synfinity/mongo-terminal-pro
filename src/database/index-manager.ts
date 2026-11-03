import type { CreateIndexesOptions, Document, IndexDirection, MongoClient } from 'mongodb';
import { ValidationError } from '../core/error-handler.js';
import { Operations, type PermissionManager } from '../security/permission-manager.js';
import { isPlainObject, parseMongoObject } from '../utils/validation.js';
import { isUnauthorized } from './helpers.js';

export type IndexType = 'single' | 'compound' | 'text' | 'geo' | 'hashed' | 'wildcard' | 'ttl' | 'clustered';

export interface IndexInfo {
  name: string;
  key: Record<string, unknown>;
  fields: string[];
  type: IndexType;
  unique: boolean;
  sparse: boolean;
  ttlSeconds?: number;
  partialFilterExpression?: Document;
  hidden: boolean;
  collation?: Document;
  sizeBytes?: number;
  version?: number;
}

export interface IndexUsage {
  name: string;
  ops: number;
  since?: Date;
  host?: string;
}

export function classifyIndex(
  key: Record<string, unknown>,
  options: { expireAfterSeconds?: number; clustered?: boolean },
): IndexType {
  const values = Object.values(key);
  const fields = Object.keys(key);
  if (options.clustered) return 'clustered';
  if (values.includes('text') || fields.includes('_fts')) return 'text';
  if (values.some((v) => v === '2dsphere' || v === '2d' || v === 'geoHaystack')) return 'geo';
  if (values.includes('hashed')) return 'hashed';
  if (fields.some((f) => f === '$**' || f.endsWith('.$**'))) return 'wildcard';
  if (options.expireAfterSeconds !== undefined) return 'ttl';
  return fields.length > 1 ? 'compound' : 'single';
}

const VALID_KEY_VALUES = new Set<unknown>([1, -1, 'text', '2dsphere', '2d', 'hashed']);

/** Parses `{ field: 1, other: -1 }` and validates key directions/types. */
export function parseIndexKeys(input: string): Record<string, IndexDirection> {
  const keys = parseMongoObject(input, 'Index keys');
  const entries = Object.entries(keys);
  if (entries.length === 0) throw new ValidationError('Index needs at least one field, e.g. { email: 1 }');
  for (const [field, value] of entries) {
    if (!VALID_KEY_VALUES.has(value)) {
      throw new ValidationError(`Index key "${field}" must be 1, -1, "text", "2dsphere", "2d" or "hashed"`);
    }
  }
  return keys as Record<string, IndexDirection>;
}

export interface CreateIndexInput {
  keys: Record<string, IndexDirection>;
  name?: string;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Document;
  hidden?: boolean;
}

export class IndexManager {
  constructor(
    private readonly client: MongoClient,
    private readonly permissions: PermissionManager,
  ) {}

  private coll(database: string, collection: string) {
    return this.client.db(database).collection(collection);
  }

  async list(
    database: string,
    collection: string,
    indexSizes: Record<string, number> = {},
  ): Promise<IndexInfo[]> {
    const raw = await this.coll(database, collection).listIndexes().toArray(); // bounded: max 64 indexes per collection
    return raw.map((idx) => {
      const key = (idx.key ?? {}) as Record<string, unknown>;
      return {
        name: String(idx.name),
        key,
        fields: Object.entries(key).map(
          ([f, v]) => `${f}: ${typeof v === 'string' ? v : v === -1 ? 'desc' : 'asc'}`,
        ),
        type: classifyIndex(key, {
          expireAfterSeconds: idx.expireAfterSeconds as number | undefined,
          clustered: Boolean(idx.clustered),
        }),
        unique: Boolean(idx.unique) || idx.name === '_id_',
        sparse: Boolean(idx.sparse),
        ttlSeconds: idx.expireAfterSeconds as number | undefined,
        partialFilterExpression: idx.partialFilterExpression as Document | undefined,
        hidden: Boolean(idx.hidden),
        collation: idx.collation as Document | undefined,
        sizeBytes: indexSizes[String(idx.name)],
        version: idx.v as number | undefined,
      };
    });
  }

  /** Index usage counters via $indexStats (since last server restart; per host). */
  async usage(
    database: string,
    collection: string,
  ): Promise<{ supported: boolean; usage: IndexUsage[]; message?: string }> {
    try {
      const cursor = this.coll(database, collection).aggregate([{ $indexStats: {} }]);
      const usage: IndexUsage[] = [];
      for await (const d of cursor) {
        const accesses = d.accesses as { ops?: number | { toNumber(): number }; since?: Date } | undefined;
        const ops =
          typeof accesses?.ops === 'number' ? accesses.ops : Number(accesses?.ops?.toNumber?.() ?? 0);
        usage.push({ name: String(d.name), ops, since: accesses?.since, host: d.host as string | undefined });
        if (usage.length > 1000) break;
      }
      await cursor.close();
      return { supported: true, usage };
    } catch (error) {
      return {
        supported: false,
        usage: [],
        message: isUnauthorized(error)
          ? 'Not authorised to run $indexStats'
          : `Index usage unavailable: ${(error as Error).message}`,
      };
    }
  }

  async create(database: string, collection: string, input: CreateIndexInput): Promise<string> {
    this.permissions.assert(Operations.createIndex);
    const options: CreateIndexesOptions = {};
    if (input.name) options.name = input.name;
    if (input.unique) options.unique = true;
    if (input.sparse) options.sparse = true;
    if (input.hidden) options.hidden = true;
    if (input.expireAfterSeconds !== undefined) {
      if (
        !Number.isInteger(input.expireAfterSeconds) ||
        input.expireAfterSeconds < 0 ||
        input.expireAfterSeconds > 2_147_483_647
      ) {
        throw new ValidationError('TTL (expireAfterSeconds) must be an integer between 0 and 2147483647');
      }
      if (Object.keys(input.keys).length !== 1)
        throw new ValidationError('TTL indexes must be on a single date field');
      options.expireAfterSeconds = input.expireAfterSeconds;
    }
    if (input.partialFilterExpression) {
      if (!isPlainObject(input.partialFilterExpression))
        throw new ValidationError('Partial filter must be an object');
      if (input.sparse) throw new ValidationError('An index cannot be both sparse and partial');
      options.partialFilterExpression = input.partialFilterExpression;
    }
    return this.coll(database, collection).createIndex(input.keys, options);
  }

  async drop(database: string, collection: string, name: string): Promise<void> {
    if (name === '_id_') throw new ValidationError('The _id index cannot be dropped');
    this.permissions.assert(Operations.dropIndex);
    await this.coll(database, collection).dropIndex(name);
  }
}
