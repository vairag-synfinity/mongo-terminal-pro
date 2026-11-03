import type { Document, Filter, MongoClient, Sort, UpdateFilter } from 'mongodb';
import type { QueryOperation } from '../config/configuration.js';
import { ValidationError } from '../core/error-handler.js';
import {
  Operations,
  type OperationDescriptor,
  type PermissionManager,
} from '../security/permission-manager.js';
import { isPlainObject, parseMongoObject, parseMongoValue } from '../utils/validation.js';
import { elapsed, takeFromCursor } from './helpers.js';

export const READ_OPERATIONS: QueryOperation[] = ['find', 'findOne', 'count', 'distinct'];
export const WRITE_OPERATIONS: QueryOperation[] = ['updateOne', 'updateMany', 'deleteOne', 'deleteMany'];

export interface QueryInput {
  database: string;
  collection: string;
  operation: QueryOperation;
  filter: string;
  projection?: string;
  sort?: string;
  update?: string;
  distinctField?: string;
  limit?: number;
  skip?: number;
}

export interface ParsedQuery {
  database: string;
  collection: string;
  operation: QueryOperation;
  filter: Filter<Document>;
  projection?: Document;
  sort?: Sort;
  update?: UpdateFilter<Document> | Document[];
  distinctField?: string;
  limit: number;
  skip: number;
  warnings: string[];
  /** Permission descriptor for write operations. */
  permission?: OperationDescriptor;
  /** True when a write affects every document (empty filter). */
  affectsAll: boolean;
}

export interface QueryLimits {
  resultLimit: number;
  timeoutMs: number;
}

export interface QueryResult {
  operation: QueryOperation;
  documents?: Document[];
  values?: unknown[];
  count?: number;
  matched?: number;
  modified?: number;
  deleted?: number;
  upsertedId?: unknown;
  durationMs: number;
  truncated: boolean;
  effectiveLimit?: number;
}

const UPDATE_OPERATORS = new Set([
  '$set',
  '$unset',
  '$inc',
  '$mul',
  '$rename',
  '$min',
  '$max',
  '$currentDate',
  '$setOnInsert',
  '$push',
  '$pull',
  '$pullAll',
  '$addToSet',
  '$pop',
  '$bit',
]);

const DANGEROUS_QUERY_OPERATORS = ['$where', '$function', '$accumulator'];

function findOperators(value: unknown, found: Set<string>, depth = 0): void {
  if (depth > 100 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const v of value) findOperators(v, found, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('$')) found.add(k);
    findOperators(v, found, depth + 1);
  }
}

/** Parses and validates a query without touching the database. */
export function parseQuery(input: QueryInput, limits: QueryLimits): ParsedQuery {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tryParse = <T>(label: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (error) {
      errors.push(`${label}: ${(error as Error).message}`);
      return undefined;
    }
  };
  if (!input.database) errors.push('Database is required');
  if (!input.collection) errors.push('Collection is required');

  const filter = tryParse('Filter', () => parseMongoObject(input.filter ?? '', 'Filter')) ?? {};
  const projection = input.projection?.trim()
    ? tryParse('Projection', () => parseMongoObject(input.projection ?? '', 'Projection'))
    : undefined;
  const sort = input.sort?.trim()
    ? (tryParse('Sort', () => parseMongoObject(input.sort ?? '', 'Sort')) as Sort | undefined)
    : undefined;

  const ops = new Set<string>();
  findOperators(filter, ops);
  for (const dangerous of DANGEROUS_QUERY_OPERATORS) {
    if (ops.has(dangerous))
      warnings.push(`${dangerous} runs JavaScript on the server and may be slow or disabled.`);
  }
  if (sort && isPlainObject(sort)) {
    for (const [field, dir] of Object.entries(sort)) {
      if (dir !== 1 && dir !== -1 && !(isPlainObject(dir) && '$meta' in dir)) {
        errors.push(`Sort: "${field}" must be 1 (ascending) or -1 (descending)`);
      }
    }
  }

  const rawLimit = input.limit ?? 0;
  if (!Number.isInteger(rawLimit) || rawLimit < 0) errors.push('Limit must be a non-negative integer');
  const skip = input.skip ?? 0;
  if (!Number.isInteger(skip) || skip < 0) errors.push('Skip must be a non-negative integer');
  let limit = rawLimit === 0 ? limits.resultLimit : rawLimit;
  if (limit > limits.resultLimit) {
    warnings.push(`Limit reduced to the configured maximum of ${limits.resultLimit} documents.`);
    limit = limits.resultLimit;
  }
  if (skip > 100_000) warnings.push('Large skip values are slow; prefer a range filter on an indexed field.');

  let update: ParsedQuery['update'];
  let permission: OperationDescriptor | undefined;
  const affectsAll = Object.keys(filter).length === 0;
  if (input.operation === 'updateOne' || input.operation === 'updateMany') {
    const parsed = tryParse('Update', () => parseMongoValue(input.update?.trim() || ''));
    if (parsed !== undefined) {
      if (Array.isArray(parsed)) {
        if (parsed.length === 0) errors.push('Update pipeline must contain at least one stage');
        update = parsed as Document[];
      } else if (isPlainObject(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length === 0) errors.push('Update document is empty');
        const nonOperators = keys.filter((k) => !k.startsWith('$'));
        if (nonOperators.length > 0) {
          errors.push(
            `Update must use operators like $set (found plain field "${nonOperators[0]}"). Use the document editor to replace whole documents.`,
          );
        }
        const unknown = keys.filter((k) => k.startsWith('$') && !UPDATE_OPERATORS.has(k));
        if (unknown.length > 0) errors.push(`Unknown update operator ${unknown.join(', ')}`);
        update = parsed as UpdateFilter<Document>;
      } else {
        errors.push('Update must be an object such as { $set: { field: value } } or a pipeline array');
      }
    }
    permission = input.operation === 'updateMany' ? Operations.updateMany : Operations.updateDocument;
    if (input.operation === 'updateMany' && affectsAll)
      warnings.push('The filter is empty: this will update EVERY document in the collection.');
  }
  if (input.operation === 'deleteOne' || input.operation === 'deleteMany') {
    permission = input.operation === 'deleteMany' ? Operations.deleteMany : Operations.deleteDocument;
    if (input.operation === 'deleteMany' && affectsAll)
      warnings.push('The filter is empty: this will delete EVERY document in the collection.');
  }
  if (input.operation === 'distinct') {
    if (!input.distinctField?.trim()) errors.push('Distinct requires a field name');
  }
  if (errors.length > 0) throw new ValidationError('Query is not valid', errors);
  return {
    database: input.database,
    collection: input.collection,
    operation: input.operation,
    filter,
    projection,
    sort,
    update,
    distinctField: input.distinctField?.trim(),
    limit,
    skip,
    warnings,
    permission,
    affectsAll,
  };
}

export class QueryManager {
  constructor(
    private readonly client: MongoClient,
    private readonly permissions: PermissionManager,
  ) {}

  private coll(q: ParsedQuery) {
    return this.client.db(q.database).collection(q.collection);
  }

  /** Number of documents a write would affect (bounded by maxTimeMS) — shown before confirmation. */
  async previewAffected(q: ParsedQuery, timeoutMs: number): Promise<number | undefined> {
    try {
      if (q.operation === 'updateOne' || q.operation === 'deleteOne') {
        return (await this.coll(q).countDocuments(q.filter, { limit: 1, maxTimeMS: timeoutMs })) as number;
      }
      return await this.coll(q).countDocuments(q.filter, { maxTimeMS: timeoutMs });
    } catch {
      return undefined;
    }
  }

  async execute(q: ParsedQuery, limits: QueryLimits, signal?: AbortSignal): Promise<QueryResult> {
    if (q.permission) this.permissions.assert(q.permission);
    const started = process.hrtime.bigint();
    const maxTimeMS = limits.timeoutMs;
    const coll = this.coll(q);
    switch (q.operation) {
      case 'find': {
        const cursor = coll.find(q.filter, {
          projection: q.projection,
          sort: q.sort,
          skip: q.skip || undefined,
          limit: q.limit + 1,
          maxTimeMS,
          batchSize: Math.min(q.limit + 1, 1000),
        });
        const { documents } = await takeFromCursor(cursor, q.limit + 1, signal);
        const truncated = documents.length > q.limit;
        return {
          operation: 'find',
          documents: truncated ? documents.slice(0, q.limit) : documents,
          durationMs: elapsed(started),
          truncated,
          effectiveLimit: q.limit,
        };
      }
      case 'findOne': {
        const doc = await coll.findOne(q.filter, {
          projection: q.projection,
          sort: q.sort,
          skip: q.skip || undefined,
          maxTimeMS,
        });
        return {
          operation: 'findOne',
          documents: doc ? [doc] : [],
          durationMs: elapsed(started),
          truncated: false,
        };
      }
      case 'count': {
        const count = await coll.countDocuments(q.filter, { maxTimeMS, skip: q.skip || undefined });
        return { operation: 'count', count, durationMs: elapsed(started), truncated: false };
      }
      case 'distinct': {
        const values = await coll.distinct(q.distinctField ?? '', q.filter, { maxTimeMS });
        const truncated = values.length > q.limit;
        return {
          operation: 'distinct',
          values: truncated ? values.slice(0, q.limit) : values,
          count: values.length,
          durationMs: elapsed(started),
          truncated,
        };
      }
      case 'updateOne':
      case 'updateMany': {
        const res =
          q.operation === 'updateOne'
            ? await coll.updateOne(q.filter, q.update as UpdateFilter<Document>, { maxTimeMS } as never)
            : await coll.updateMany(q.filter, q.update as UpdateFilter<Document>, { maxTimeMS } as never);
        return {
          operation: q.operation,
          matched: res.matchedCount,
          modified: res.modifiedCount,
          upsertedId: res.upsertedId ?? undefined,
          durationMs: elapsed(started),
          truncated: false,
        };
      }
      case 'deleteOne':
      case 'deleteMany': {
        const res =
          q.operation === 'deleteOne' ? await coll.deleteOne(q.filter) : await coll.deleteMany(q.filter);
        return {
          operation: q.operation,
          deleted: res.deletedCount,
          durationMs: elapsed(started),
          truncated: false,
        };
      }
    }
  }
}
