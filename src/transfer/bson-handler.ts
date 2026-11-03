import { BSON, type Document } from '../utils/bson.js';
import type { Readable, Writable } from 'node:stream';

/**
 * BSON files as produced by mongodump: a plain concatenation of BSON documents, each prefixed by
 * its int32 little-endian length. Read in a streaming fashion with a bounded buffer.
 */

const MIN_DOC = 5;
// mongodump may write documents up to 16 MB plus internal overhead.
const MAX_DOC = 16 * 1024 * 1024 + 16 * 1024;

export interface ParsedBsonDocument {
  index: number;
  offset: number;
  document?: Document;
  error?: string;
}

export async function* readBsonDocuments(stream: Readable): AsyncGenerator<ParsedBsonDocument> {
  let pending: Buffer = Buffer.alloc(0);
  let index = 0;
  let offset = 0;
  for await (const chunk of stream) {
    pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
    let pos = 0;
    while (pending.length - pos >= 4) {
      const size = pending.readInt32LE(pos);
      if (size < MIN_DOC || size > MAX_DOC) {
        throw new Error(`Corrupt BSON at byte ${offset + pos}: invalid document length ${size}`);
      }
      if (pending.length - pos < size) break;
      const slice = pending.subarray(pos, pos + size);
      try {
        // promoteValues: false keeps Int32 / Int64 / Double distinct so re-inserting is lossless.
        const document = BSON.deserialize(slice, {
          promoteValues: false,
          promoteBuffers: false,
          validation: { utf8: true },
        });
        yield { index, offset: offset + pos, document };
      } catch (error) {
        yield { index, offset: offset + pos, error: `Invalid BSON document: ${(error as Error).message}` };
      }
      index++;
      pos += size;
    }
    offset += pos;
    pending = pos === 0 ? pending : Buffer.from(pending.subarray(pos));
  }
  if (pending.length > 0)
    throw new Error(`Truncated BSON file: ${pending.length} trailing bytes at offset ${offset}`);
}

/** Counts documents without deserialising them fully (used by backup verification). */
export async function countBsonDocuments(stream: Readable): Promise<{ documents: number; bytes: number }> {
  let pending: Buffer = Buffer.alloc(0);
  let documents = 0;
  let bytes = 0;
  for await (const chunk of stream) {
    pending = pending.length === 0 ? (chunk as Buffer) : Buffer.concat([pending, chunk as Buffer]);
    let pos = 0;
    while (pending.length - pos >= 4) {
      const size = pending.readInt32LE(pos);
      if (size < MIN_DOC || size > MAX_DOC) throw new Error(`Corrupt BSON: invalid document length ${size}`);
      if (pending.length - pos < size) break;
      if (pending[pos + size - 1] !== 0) throw new Error('Corrupt BSON: document is not null-terminated');
      documents++;
      pos += size;
    }
    bytes += pos;
    pending = pos === 0 ? pending : Buffer.from(pending.subarray(pos));
  }
  if (pending.length > 0) throw new Error('Truncated BSON file');
  return { documents, bytes };
}

export class BsonDocumentWriter {
  bytes = 0;

  constructor(private readonly out: Writable) {}

  /** Accepts a document or an already-serialised raw BSON buffer (lossless pass-through). */
  async write(doc: Document | Uint8Array): Promise<void> {
    const buf = doc instanceof Uint8Array ? doc : BSON.serialize(doc);
    this.bytes += buf.length;
    if (!this.out.write(buf)) {
      await new Promise<void>((resolve) => this.out.once('drain', () => resolve()));
    }
  }

  /** Raw BSON has no trailer; kept for writer symmetry. */
  async end(): Promise<void> {}
}
