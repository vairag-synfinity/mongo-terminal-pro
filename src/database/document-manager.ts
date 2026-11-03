import type { Document, Filter, MongoClient, Sort } from 'mongodb';
import { ValidationError } from '../core/error-handler.js';
import { Operations, type PermissionManager } from '../security/permission-manager.js';
import { clampPageSize, type KeysetAnchors, type PageInfo } from '../utils/pagination.js';
import { validateDocument } from '../utils/validation.js';
import { takeFromCursor } from './helpers.js';

export interface FindPageRequest {
  database: string;
  collection: string;
  filter?: Filter<Document>;
  projection?: Document;
  sort?: Sort;
  page: number;
  pageSize: number;
  /** Keyset anchors kept by the caller across page navigation. */
  anchors?: KeysetAnchors<unknown>;
  maxTimeMS: number;
}

export interface DocumentPage {
  documents: Document[];
  pageInfo: PageInfo;
}

type IdDirection = 1 | -1;

/** Returns 1/-1 when the sort is on _id only (or empty → natural _id ascending), else undefined. */
export function keysetDirection(sort: Sort | undefined): IdDirection | undefined {
  if (sort === undefined) return 1;
  if (typeof sort !== 'object' || Array.isArray(sort) || sort instanceof Map) return undefined;
  const entries = Object.entries(sort as Record<string, unknown>);
  if (entries.length === 0) return 1;
  if (entries.length !== 1 || entries[0]?.[0] !== '_id') return undefined;
  const v = entries[0][1];
  if (v === 1 || v === 'asc' || v === 'ascending') return 1;
  if (v === -1 || v === 'desc' || v === 'descending') return -1;
  return undefined;
}

export class DocumentManager {
  constructor(
    private readonly client: MongoClient,
    private readonly permissions: PermissionManager,
  ) {}

  private coll(database: string, collection: string) {
    return this.client.db(database).collection(collection);
  }

  /**
   * Fetches one page. Uses keyset pagination on _id when the sort allows it (constant cost at any
   * depth) and falls back to skip/limit otherwise. Fetches pageSize+1 to detect a next page.
   */
  async findPage(req: FindPageRequest): Promise<DocumentPage> {
    const pageSize = clampPageSize(req.pageSize);
    const filter = req.filter ?? {};
    const direction = keysetDirection(req.sort);
    const anchors = req.anchors;
    const useKeyset = direction !== undefined && anchors !== undefined && anchors.has(req.page);
    let query: Filter<Document> = filter;
    let skip = 0;
    if (useKeyset) {
      const anchor = anchors.get(req.page);
      if (anchor !== null && anchor !== undefined) {
        const bound = { _id: { [direction === 1 ? '$gt' : '$lt']: anchor } };
        query = Object.keys(filter).length === 0 ? bound : { $and: [filter, bound] };
      }
    } else {
      skip = req.page * pageSize;
    }
    const sort: Sort = direction !== undefined ? { _id: direction } : (req.sort as Sort);
    const cursor = this.coll(req.database, req.collection).find(query, {
      projection: req.projection,
      sort,
      skip: skip || undefined,
      limit: pageSize + 1,
      maxTimeMS: req.maxTimeMS,
      batchSize: pageSize + 1,
      // Keep Int32 / Int64 / Double wrappers so viewing and editing never change numeric types.
      promoteValues: false,
    });
    const { documents } = await takeFromCursor(cursor, pageSize + 1);
    const hasNext = documents.length > pageSize;
    const pageDocs = hasNext ? documents.slice(0, pageSize) : documents;
    if (direction !== undefined && anchors && pageDocs.length > 0) {
      const last = pageDocs[pageDocs.length - 1];
      if (last && '_id' in last) anchors.record(req.page, last._id);
    }
    return {
      documents: pageDocs,
      pageInfo: {
        page: req.page,
        pageSize,
        itemCount: pageDocs.length,
        hasNext,
        hasPrevious: req.page > 0,
        strategy: useKeyset ? 'keyset' : 'offset',
      },
    };
  }

  async findById(database: string, collection: string, id: unknown): Promise<Document | null> {
    return this.coll(database, collection).findOne({ _id: id } as Filter<Document>, {
      maxTimeMS: 10_000,
      promoteValues: false,
    });
  }

  async insertOne(database: string, collection: string, doc: Document): Promise<unknown> {
    this.permissions.assert(Operations.insertDocument);
    const issues = validateDocument(doc);
    if (issues.length > 0)
      throw new ValidationError(
        'Document is not valid',
        issues.map((i) => `${i.path || '(root)'}: ${i.message}`),
      );
    const res = await this.coll(database, collection).insertOne(doc);
    return res.insertedId;
  }

  /** Replaces a document by _id. The _id cannot change (MongoDB treats _id as immutable). */
  async replaceById(
    database: string,
    collection: string,
    id: unknown,
    doc: Document,
  ): Promise<{ matched: number; modified: number }> {
    this.permissions.assert(Operations.updateDocument);
    const { _id: newId, ...rest } = doc;
    if (newId !== undefined && !sameId(newId, id)) {
      throw new ValidationError(
        'The _id field cannot be changed. Duplicate the document to create a copy with a new _id.',
      );
    }
    const issues = validateDocument(rest);
    if (issues.length > 0)
      throw new ValidationError(
        'Document is not valid',
        issues.map((i) => `${i.path || '(root)'}: ${i.message}`),
      );
    const res = await this.coll(database, collection).replaceOne({ _id: id } as Filter<Document>, rest);
    return { matched: res.matchedCount, modified: res.modifiedCount };
  }

  async deleteById(database: string, collection: string, id: unknown): Promise<number> {
    this.permissions.assert(Operations.deleteDocument);
    const res = await this.coll(database, collection).deleteOne({ _id: id } as Filter<Document>);
    return res.deletedCount;
  }

  /** Inserts a copy without _id so the server assigns a new one. */
  async duplicate(database: string, collection: string, doc: Document): Promise<unknown> {
    this.permissions.assert(Operations.duplicateDocument);
    const { _id: _ignored, ...copy } = doc;
    return this.insertOne(database, collection, copy);
  }

  /** Small bounded sample used by the collection overview. */
  async sample(database: string, collection: string, size: number, maxTimeMS: number): Promise<Document[]> {
    const cursor = this.coll(database, collection).find({}, { limit: size, maxTimeMS });
    return (await takeFromCursor(cursor, size)).documents;
  }
}

function sameId(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const ea = (a as { equals?: (o: unknown) => boolean })?.equals;
  if (typeof ea === 'function') return ea.call(a, b);
  return JSON.stringify(a) === JSON.stringify(b);
}
