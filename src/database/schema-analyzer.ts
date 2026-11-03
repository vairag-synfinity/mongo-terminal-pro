import type { Document, MongoClient } from 'mongodb';
import { isPlainObject } from '../utils/validation.js';
import { takeFromCursor } from './helpers.js';

export function bsonTypeName(value: unknown): string {
  if (value === null) return 'Null';
  if (value === undefined) return 'Undefined';
  if (Array.isArray(value)) return 'Array';
  if (value instanceof Date) return 'Date';
  if (value instanceof RegExp) return 'RegExp';
  switch (typeof value) {
    case 'string':
      return 'String';
    case 'number':
      return Number.isInteger(value) ? 'Int' : 'Double';
    case 'boolean':
      return 'Boolean';
    case 'bigint':
      return 'Long';
  }
  const bsontype = (value as { _bsontype?: string })._bsontype;
  if (bsontype) {
    if (bsontype === 'Binary') {
      const subtype = (value as { sub_type?: number }).sub_type;
      return subtype === 4 ? 'UUID' : 'Binary';
    }
    if (bsontype === 'BSONRegExp') return 'RegExp';
    return bsontype;
  }
  return isPlainObject(value) ? 'Document' : 'Unknown';
}

export interface FieldSchema {
  path: string;
  /** Occurrences per BSON type. */
  types: Record<string, number>;
  /** Number of sampled documents containing the field. */
  count: number;
  /** Fraction of sampled documents containing the field (0..1). */
  probability: number;
  depth: number;
}

export interface SchemaAnalysis {
  sampleSize: number;
  fields: FieldSchema[];
  method: '$sample' | 'find';
}

const MAX_DEPTH = 8;
const MAX_FIELDS = 1000;

/** Infers field paths and types from a set of documents. Exported for unit tests. */
export function analyzeDocuments(docs: Document[]): FieldSchema[] {
  const stats = new Map<string, { types: Record<string, number>; docs: number; depth: number }>();
  for (const doc of docs) {
    const seenInDoc = new Set<string>();
    const visit = (value: unknown, path: string, depth: number) => {
      if (stats.size >= MAX_FIELDS && !stats.has(path)) return;
      const type = bsonTypeName(value);
      let entry = stats.get(path);
      if (!entry) {
        entry = { types: {}, docs: 0, depth };
        stats.set(path, entry);
      }
      entry.types[type] = (entry.types[type] ?? 0) + 1;
      if (!seenInDoc.has(path)) {
        seenInDoc.add(path);
        entry.docs++;
      }
      if (depth >= MAX_DEPTH) return;
      if (type === 'Document') {
        for (const [k, v] of Object.entries(value as Document)) visit(v, `${path}.${k}`, depth + 1);
      } else if (type === 'Array') {
        for (const item of (value as unknown[]).slice(0, 50)) {
          const itemType = bsonTypeName(item);
          if (itemType === 'Document') {
            for (const [k, v] of Object.entries(item as Document)) visit(v, `${path}[].${k}`, depth + 1);
          } else {
            const key = `${path}[]`;
            let e = stats.get(key);
            if (!e) {
              e = { types: {}, docs: 0, depth: depth + 1 };
              stats.set(key, e);
            }
            e.types[itemType] = (e.types[itemType] ?? 0) + 1;
            if (!seenInDoc.has(key)) {
              seenInDoc.add(key);
              e.docs++;
            }
          }
        }
      }
    };
    for (const [k, v] of Object.entries(doc)) visit(v, k, 0);
  }
  const total = docs.length || 1;
  return [...stats.entries()]
    .map(([path, s]) => ({
      path,
      types: s.types,
      count: s.docs,
      probability: s.docs / total,
      depth: s.depth,
    }))
    .sort((a, b) => (a.path === '_id' ? -1 : b.path === '_id' ? 1 : a.path.localeCompare(b.path)));
}

export class SchemaAnalyzer {
  constructor(private readonly client: MongoClient) {}

  /** Samples up to `sampleSize` documents with $sample (random, index-free) and infers a schema. */
  async analyze(
    database: string,
    collection: string,
    sampleSize: number,
    maxTimeMS: number,
  ): Promise<SchemaAnalysis> {
    const coll = this.client.db(database).collection(collection);
    let docs: Document[];
    let method: SchemaAnalysis['method'] = '$sample';
    try {
      const cursor = coll.aggregate([{ $sample: { size: sampleSize } }], { maxTimeMS });
      docs = (await takeFromCursor(cursor, sampleSize)).documents;
    } catch {
      // Views and some server configurations do not support $sample.
      method = 'find';
      docs = (await takeFromCursor(coll.find({}, { limit: sampleSize, maxTimeMS }), sampleSize)).documents;
    }
    return { sampleSize: docs.length, fields: analyzeDocuments(docs), method };
  }
}
