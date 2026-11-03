import {
  bsonType,
  EJSON,
  UUID,
  type Binary,
  type Decimal128,
  type Document,
  type Long,
  type ObjectId,
  type Timestamp,
} from '../utils/bson.js';
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { isPlainObject } from '../utils/validation.js';

/**
 * JSON import/export.
 *
 * Reading streams the input and splits top-level values without buffering the whole file:
 *  - JSON array:         [ {...}, {...} ]
 *  - JSON Lines / NDJSON: one document per line (the mongoexport default)
 *  - concatenated objects separated by whitespace
 * Each document is parsed as Extended JSON (canonical or relaxed), so {"$oid": ...},
 * {"$date": ...}, {"$numberLong": ...} etc. become real BSON types.
 *
 * Export modes:
 *  - canonical EJSON: lossless, every type annotated ({"$numberInt":"1"})
 *  - relaxed EJSON:   readable, keeps ObjectId/Date/Long/Decimal annotations, numbers stay numbers
 *  - plain JSON:      ordinary JSON for other tools; BSON types become strings/numbers (LOSSY)
 */

export type JsonLayout = 'array' | 'jsonl';
export type JsonMode = 'canonical' | 'relaxed' | 'plain';

export interface RawJsonValue {
  text: string;
  index: number;
  line: number;
}

const MAX_VALUE_CHARS = 48 * 1024 * 1024; // a 16 MB BSON document is well below this as JSON

/** Splits a character stream into top-level JSON values. */
export async function* splitJsonValues(stream: Readable): AsyncGenerator<RawJsonValue> {
  const decoder = new StringDecoder('utf8');
  let mode: 'unknown' | 'array' | 'stream' = 'unknown';
  let depth = 0;
  let inString = false;
  let escape = false;
  let buffer: string[] = [];
  let bufferLength = 0;
  let capturing = false;
  let index = 0;
  let line = 1;
  let valueLine = 1;
  let arrayClosed = false;
  let first = true;

  const fail = (msg: string): never => {
    throw new Error(`${msg} at line ${line}`);
  };

  for await (const chunk of stream) {
    let text = typeof chunk === 'string' ? chunk : decoder.write(chunk as Buffer);
    // The BOM may arrive split across chunks; strip it from the first decoded text.
    if (first && text.length > 0) {
      text = text.replace(/^\uFEFF/, '');
      first = false;
    }
    let segmentStart = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;
      if (ch === '\n') line++;
      if (capturing) {
        if (inString) {
          if (escape) escape = false;
          else if (ch === '\\') escape = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') {
          depth--;
          if (depth === 0) {
            buffer.push(text.slice(segmentStart, i + 1));
            const value = buffer.join('');
            buffer = [];
            bufferLength = 0;
            capturing = false;
            yield { text: value, index: index++, line: valueLine };
          }
        }
        continue;
      }
      // Between values.
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') continue;
      if (mode === 'unknown') {
        if (ch === '[') {
          mode = 'array';
          continue;
        }
        mode = 'stream';
      }
      if (mode === 'array') {
        if (arrayClosed) fail('Unexpected content after the closing "]"');
        if (ch === ',') continue;
        if (ch === ']') {
          arrayClosed = true;
          continue;
        }
      }
      if (ch === '{') {
        capturing = true;
        depth = 1;
        inString = false;
        escape = false;
        segmentStart = i;
        valueLine = line;
        continue;
      }
      fail(`Expected a JSON object but found '${ch}'`);
    }
    if (capturing) {
      const part = text.slice(segmentStart);
      buffer.push(part);
      bufferLength += part.length;
      if (bufferLength > MAX_VALUE_CHARS) fail('A single JSON document exceeds the maximum supported size');
    }
  }
  const rest = decoder.end();
  if (rest.trim()) fail('Unexpected trailing data');
  if (capturing) fail('Unexpected end of file inside a JSON document');
  if (mode === 'array' && !arrayClosed) fail('Unexpected end of file: missing closing "]"');
}

export interface ParsedJsonDocument {
  index: number;
  line: number;
  document?: Document;
  error?: string;
}

function parseJsonDocument(text: string, index: number, line: number): ParsedJsonDocument {
  try {
    const value = EJSON.parse(text, { relaxed: false }) as unknown;
    if (!isPlainObject(value)) return { index, line, error: 'Value is not a JSON object' };
    return { index, line, document: value };
  } catch (error) {
    return { index, line, error: `Invalid JSON: ${(error as Error).message}` };
  }
}

/**
 * JSON Lines: every non-empty line is an independent document, so one malformed line is reported
 * on its own instead of breaking the rest of the file.
 */
export async function* readJsonLines(stream: Readable): AsyncGenerator<ParsedJsonDocument> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  let index = 0;
  for await (const raw of rl) {
    line++;
    const text = line === 1 ? raw.replace(/^\uFEFF/, '') : raw;
    if (!text.trim()) continue;
    if (text.length > MAX_VALUE_CHARS) {
      yield { index: index++, line, error: 'Line exceeds the maximum supported document size' };
      continue;
    }
    yield parseJsonDocument(text, index++, line);
  }
}

/** Streams documents from JSON/JSONL input. Parse errors are reported per document. */
export async function* readJsonDocuments(
  stream: Readable,
  options: { lines?: boolean } = {},
): AsyncGenerator<ParsedJsonDocument> {
  if (options.lines) {
    yield* readJsonLines(stream);
    return;
  }
  for await (const raw of splitJsonValues(stream)) {
    yield parseJsonDocument(raw.text, raw.index, raw.line);
  }
}

/** Converts BSON values to ordinary JSON values (lossy, for interoperability). */
export function toPlainJson(value: unknown, depth = 0): unknown {
  if (depth > 200) return null;
  if (value === null || value === undefined) return value ?? null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map((v) => toPlainJson(v, depth + 1));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object')
    return typeof value === 'number' && !Number.isFinite(value) ? String(value) : value;
  const bsontype = bsonType(value);
  if (bsontype) {
    if (bsontype === 'ObjectId') return (value as ObjectId).toHexString();
    if (bsontype === 'Decimal128') return (value as Decimal128).toString();
    if (bsontype === 'Long') {
      const n = (value as Long).toNumber();
      return Number.isSafeInteger(n) ? n : (value as Long).toString();
    }
    if (bsontype === 'Binary') {
      const bin = value as Binary;
      if (bin.sub_type === 4) return new UUID(bin.buffer).toHexString(true);
      return Buffer.from(bin.buffer).toString('base64');
    }
    if (bsontype === 'Timestamp') return { t: (value as Timestamp).t, i: (value as Timestamp).i };
    if (bsontype === 'Int32' || bsontype === 'Double') return (value as { value: number }).value;
    if (bsontype === 'BSONRegExp') {
      const r = value as unknown as { pattern: string; options: string };
      return `/${r.pattern}/${r.options}`;
    }
    if (bsontype === 'MinKey' || bsontype === 'MaxKey') return bsontype;
    if (bsontype === 'Code') return (value as { code: string }).code;
    return String(value);
  }
  if (value instanceof RegExp) return value.toString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = toPlainJson(v, depth + 1);
  return out;
}

/**
 * Relaxed Extended JSON writes Int64 as a plain JSON number, which silently loses precision above
 * 2^53. Such values are kept as {"$numberLong": "..."} so relaxed exports never corrupt data.
 */
export function protectUnsafeLongs(value: unknown, depth = 0): unknown {
  if (depth > 200 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => protectUnsafeLongs(v, depth + 1));
  if (bsonType(value) === 'Long') {
    const long = value as Long;
    return Number.isSafeInteger(long.toNumber()) ? value : { $numberLong: long.toString() };
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = protectUnsafeLongs(v, depth + 1);
  return out;
}

export function serializeJsonDocument(doc: Document, mode: JsonMode, pretty = false): string {
  const space = pretty ? 2 : undefined;
  if (mode === 'plain') return JSON.stringify(toPlainJson(doc), null, space);
  if (mode === 'relaxed')
    return EJSON.stringify(protectUnsafeLongs(doc) as Document, undefined, space, { relaxed: true });
  return EJSON.stringify(doc, undefined, space, { relaxed: false });
}

async function writeChunk(out: Writable, text: string): Promise<number> {
  const bytes = Buffer.byteLength(text);
  if (!out.write(text)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        out.off('error', onError);
        resolve();
      };
      const onError = (e: Error) => {
        out.off('drain', onDrain);
        reject(e);
      };
      out.once('drain', onDrain);
      out.once('error', onError);
    });
  }
  return bytes;
}

/** Streaming JSON writer honouring backpressure. */
export class JsonDocumentWriter {
  private count = 0;
  bytes = 0;

  constructor(
    private readonly out: Writable,
    private readonly layout: JsonLayout,
    private readonly mode: JsonMode,
  ) {}

  async begin(): Promise<void> {
    if (this.layout === 'array') this.bytes += await writeChunk(this.out, '[\n');
  }

  async write(doc: Document): Promise<void> {
    const json = serializeJsonDocument(doc, this.mode);
    const prefix = this.layout === 'array' && this.count > 0 ? ',\n' : '';
    this.bytes += await writeChunk(this.out, this.layout === 'array' ? `${prefix}${json}` : `${json}\n`);
    this.count++;
  }

  async end(): Promise<void> {
    if (this.layout === 'array') this.bytes += await writeChunk(this.out, this.count > 0 ? '\n]\n' : ']\n');
  }
}

export { writeChunk };
