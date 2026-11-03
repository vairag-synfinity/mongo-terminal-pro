import {
  Binary,
  BSON,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
} from './bson.js';

/**
 * A safe parser for MongoDB shell-style input. It accepts strict JSON, Extended JSON and the
 * common shell conveniences developers type every day:
 *
 *   { status: 'active', _id: ObjectId("..."), at: ISODate("2024-01-01"), n: NumberLong(5), re: /ab/i }
 *
 * It never evaluates code: input is tokenised and only a fixed whitelist of constructors is
 * understood. The result is passed through EJSON.deserialize so `{ "$oid": ... }` style values
 * become real BSON types as well.
 */
export class ParseError extends Error {
  constructor(
    message: string,
    public readonly position: number,
    public readonly line: number,
    public readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = 'ParseError';
  }
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;

class MongoShellParser {
  private pos = 0;

  constructor(private readonly src: string) {}

  parse(): unknown {
    this.skipWs();
    const value = this.parseValue();
    this.skipWs();
    if (this.pos < this.src.length) this.fail(`Unexpected '${this.src[this.pos]}'`);
    return value;
  }

  private fail(message: string): never {
    const before = this.src.slice(0, this.pos);
    const line = before.split('\n').length;
    const column = this.pos - before.lastIndexOf('\n');
    throw new ParseError(message, this.pos, line, column);
  }

  private skipWs(): void {
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined) return;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF') {
        this.pos++;
      } else if (ch === '/' && this.src[this.pos + 1] === '/') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      } else if (ch === '/' && this.src[this.pos + 1] === '*') {
        const end = this.src.indexOf('*/', this.pos + 2);
        if (end === -1) this.fail('Unterminated comment');
        this.pos = end + 2;
      } else {
        return;
      }
    }
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.src[this.pos] !== ch) this.fail(`Expected '${ch}'`);
    this.pos++;
  }

  private parseValue(): unknown {
    this.skipWs();
    const ch = this.src[this.pos];
    if (ch === undefined) this.fail('Unexpected end of input');
    if (ch === '{') return this.parseObject();
    if (ch === '[') return this.parseArray();
    if (ch === '"' || ch === "'") return this.parseString();
    if (ch === '/') return this.parseRegex();
    if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) return this.parseNumber();
    if (IDENT_START.test(ch)) return this.parseIdentifierValue();
    this.fail(`Unexpected '${ch}'`);
  }

  private parseObject(): Record<string, unknown> {
    this.pos++; // {
    const out: Record<string, unknown> = {};
    this.skipWs();
    if (this.src[this.pos] === '}') {
      this.pos++;
      return out;
    }
    for (;;) {
      this.skipWs();
      const key = this.parseKey();
      this.expect(':');
      const value = this.parseValue();
      if (key === '__proto__') this.fail('Key "__proto__" is not allowed');
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      this.skipWs();
      const next = this.src[this.pos];
      if (next === ',') {
        this.pos++;
        this.skipWs();
        if (this.src[this.pos] === '}') {
          this.pos++;
          return out;
        }
        continue;
      }
      if (next === '}') {
        this.pos++;
        return out;
      }
      this.fail("Expected ',' or '}'");
    }
  }

  private parseKey(): string {
    const ch = this.src[this.pos];
    if (ch === '"' || ch === "'") return this.parseString();
    if (ch !== undefined && IDENT_START.test(ch)) {
      const start = this.pos;
      while (this.pos < this.src.length && /[A-Za-z0-9_$.]/.test(this.src[this.pos] ?? '')) this.pos++;
      return this.src.slice(start, this.pos);
    }
    if (ch !== undefined && /[0-9]/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos] ?? '')) this.pos++;
      return this.src.slice(start, this.pos);
    }
    this.fail('Expected a field name');
  }

  private parseArray(): unknown[] {
    this.pos++; // [
    const out: unknown[] = [];
    this.skipWs();
    if (this.src[this.pos] === ']') {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.skipWs();
      const next = this.src[this.pos];
      if (next === ',') {
        this.pos++;
        this.skipWs();
        if (this.src[this.pos] === ']') {
          this.pos++;
          return out;
        }
        continue;
      }
      if (next === ']') {
        this.pos++;
        return out;
      }
      this.fail("Expected ',' or ']'");
    }
  }

  private parseString(): string {
    const quote = this.src[this.pos];
    this.pos++;
    let out = '';
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined) this.fail('Unterminated string');
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === '\\') {
        const esc = this.src[this.pos + 1];
        this.pos += 2;
        switch (esc) {
          case 'n':
            out += '\n';
            break;
          case 't':
            out += '\t';
            break;
          case 'r':
            out += '\r';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case '0':
            out += '\0';
            break;
          case 'u': {
            const hex = this.src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid unicode escape');
            out += String.fromCharCode(Number.parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          case undefined:
            this.fail('Unterminated string');
            break;
          default:
            out += esc;
        }
        continue;
      }
      out += ch;
      this.pos++;
    }
  }

  private parseRegex(): BSON.BSONRegExp {
    this.pos++; // /
    let pattern = '';
    let inClass = false;
    for (;;) {
      const ch = this.src[this.pos];
      if (ch === undefined || ch === '\n') this.fail('Unterminated regular expression');
      if (ch === '\\') {
        pattern += ch + (this.src[this.pos + 1] ?? '');
        this.pos += 2;
        continue;
      }
      if (ch === '[') inClass = true;
      if (ch === ']') inClass = false;
      if (ch === '/' && !inClass) {
        this.pos++;
        break;
      }
      pattern += ch;
      this.pos++;
    }
    const start = this.pos;
    while (/[a-z]/.test(this.src[this.pos] ?? '')) this.pos++;
    const flags = this.src.slice(start, this.pos);
    if (/[^imsxu]/.test(flags)) this.fail(`Unsupported regular expression flags '${flags}'`);
    return new BSON.BSONRegExp(pattern, flags);
  }

  private parseNumber(): number {
    const start = this.pos;
    const match = /^[+-]?(Infinity|NaN|0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(
      this.src.slice(this.pos),
    );
    if (!match) this.fail('Invalid number');
    this.pos = start + match[0].length;
    const text = match[0];
    if (/^[+-]?0[xX]/.test(text)) {
      const sign = text.startsWith('-') ? -1 : 1;
      return sign * Number.parseInt(text.replace(/^[+-]/, ''), 16);
    }
    return Number(text);
  }

  private parseIdentifier(): string {
    const start = this.pos;
    while (this.pos < this.src.length && IDENT_PART.test(this.src[this.pos] ?? '')) this.pos++;
    return this.src.slice(start, this.pos);
  }

  private parseArgs(): unknown[] {
    this.expect('(');
    const args: unknown[] = [];
    this.skipWs();
    if (this.src[this.pos] === ')') {
      this.pos++;
      return args;
    }
    for (;;) {
      args.push(this.parseValue());
      this.skipWs();
      if (this.src[this.pos] === ',') {
        this.pos++;
        continue;
      }
      if (this.src[this.pos] === ')') {
        this.pos++;
        return args;
      }
      this.fail("Expected ',' or ')'");
    }
  }

  private parseIdentifierValue(): unknown {
    const startPos = this.pos;
    let ident = this.parseIdentifier();
    if (ident === 'new') {
      this.skipWs();
      ident = this.parseIdentifier();
    }
    switch (ident) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      case 'undefined':
        return null;
      case 'Infinity':
        return Infinity;
      case 'NaN':
        return NaN;
      case 'MinKey':
        this.optionalCall();
        return new MinKey();
      case 'MaxKey':
        this.optionalCall();
        return new MaxKey();
    }
    this.skipWs();
    if (this.src[this.pos] !== '(') {
      this.pos = startPos;
      this.fail(`Unknown identifier '${ident}'. Strings must be quoted`);
    }
    const args = this.parseArgs();
    return this.construct(ident, args, startPos);
  }

  private optionalCall(): void {
    this.skipWs();
    if (this.src[this.pos] === '(') this.parseArgs();
  }

  private construct(name: string, args: unknown[], at: number): unknown {
    const first = args[0];
    const str = (label: string): string => {
      if (typeof first !== 'string') {
        this.pos = at;
        this.fail(`${label}() expects a string argument`);
      }
      return first;
    };
    try {
      switch (name) {
        case 'ObjectId':
        case 'ObjectID':
          return first === undefined ? new ObjectId() : new ObjectId(str('ObjectId'));
        case 'ISODate':
        case 'Date': {
          const d = first === undefined ? new Date() : new Date(first as string | number);
          if (Number.isNaN(d.getTime())) throw new Error('Invalid date');
          return d;
        }
        case 'NumberLong':
        case 'Long':
          return typeof first === 'number' ? Long.fromNumber(first) : Long.fromString(str('NumberLong'));
        case 'NumberInt':
        case 'Int32':
          return new Int32(Number(first));
        case 'Double':
          return new Double(Number(first));
        case 'NumberDecimal':
        case 'Decimal128':
          return Decimal128.fromString(typeof first === 'number' ? String(first) : str('NumberDecimal'));
        case 'UUID':
          return first === undefined ? new UUID() : new UUID(str('UUID'));
        case 'BinData': {
          const subtype = Number(first);
          const data = args[1];
          if (typeof data !== 'string') throw new Error('BinData(subtype, base64) expects a base64 string');
          return new Binary(Buffer.from(data, 'base64'), subtype);
        }
        case 'Timestamp': {
          if (isPlainObject(first))
            return new Timestamp({ t: Number(first.t ?? 0), i: Number(first.i ?? 0) });
          const t = Number(first ?? 0);
          const i = Number(args[1] ?? 0);
          return new Timestamp({ t, i });
        }
        case 'RegExp':
          return new BSON.BSONRegExp(str('RegExp'), typeof args[1] === 'string' ? args[1] : '');
        default:
          throw new Error(`Unsupported constructor '${name}()'`);
      }
    } catch (error) {
      if (error instanceof ParseError) throw error;
      this.pos = at;
      this.fail(error instanceof Error ? error.message : String(error));
    }
  }
}

const EJSON_WRAPPER_KEYS = new Set([
  '$oid',
  '$date',
  '$numberLong',
  '$numberInt',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$timestamp',
  '$regularExpression',
  '$minKey',
  '$maxKey',
  '$symbol',
  '$code',
  '$dbPointer',
  '$undefined',
]);

function containsEjsonWrappers(value: unknown, depth = 0): boolean {
  if (depth > 200 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => containsEjsonWrappers(v, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  for (const [k, v] of Object.entries(value)) {
    if (EJSON_WRAPPER_KEYS.has(k)) return true;
    if (containsEjsonWrappers(v, depth + 1)) return true;
  }
  return false;
}

/** Parses shell-style or Extended JSON input into BSON-ready JavaScript values. */
export function parseMongoValue(input: string): unknown {
  const value = new MongoShellParser(input).parse();
  if (containsEjsonWrappers(value)) {
    // Re-hydrate {$oid:...}, {$date:...} etc. Shell constructors are already BSON types and are
    // serialised to canonical EJSON first so nothing is lost on the round trip.
    return EJSON.deserialize(EJSON.serialize(value as object, { relaxed: false }) as object, {
      relaxed: false,
    });
  }
  return value;
}

export function parseMongoObject(input: string, label = 'Value'): Record<string, unknown> {
  const trimmed = input.trim();
  if (trimmed === '') return {};
  const value = parseMongoValue(trimmed);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object, e.g. { "field": "value" }`);
  }
  return value as Record<string, unknown>;
}

export function parseMongoArray(input: string, label = 'Value'): unknown[] {
  const value = parseMongoValue(input.trim());
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array, e.g. [ { "$match": {} } ]`);
  return value;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

export const MAX_BSON_DOCUMENT_SIZE = 16 * 1024 * 1024;

export interface DocumentValidationIssue {
  path: string;
  message: string;
}

/** Validates that a value can be stored as a MongoDB document. */
export function validateDocument(
  doc: unknown,
  options: { allowOperatorKeys?: boolean; maxDepth?: number } = {},
): DocumentValidationIssue[] {
  const issues: DocumentValidationIssue[] = [];
  if (!isPlainObject(doc)) {
    return [{ path: '', message: 'Document must be an object' }];
  }
  const maxDepth = options.maxDepth ?? 100;
  const visit = (value: unknown, path: string, depth: number) => {
    if (depth > maxDepth) {
      issues.push({ path, message: `Nesting deeper than ${maxDepth} levels is not supported` });
      return;
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
      issues.push({ path, message: `Unsupported value type ${typeof value}` });
      return;
    }
    if (typeof value === 'bigint') {
      issues.push({ path, message: 'BigInt values must be converted to Long' });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (key.includes('\0'))
          issues.push({ path: childPath, message: 'Field names cannot contain null bytes' });
        if (key.startsWith('$') && !options.allowOperatorKeys && depth === 0) {
          issues.push({ path: childPath, message: 'Top-level field names cannot start with "$"' });
        }
        visit(child, childPath, depth + 1);
      }
    }
  };
  visit(doc, '', 0);
  if (issues.length === 0) {
    try {
      const size = BSON.calculateObjectSize(doc);
      if (size > MAX_BSON_DOCUMENT_SIZE) {
        issues.push({ path: '', message: `Document is ${size} bytes; the BSON limit is 16 MB` });
      }
    } catch (error) {
      issues.push({ path: '', message: `Not BSON-serialisable: ${(error as Error).message}` });
    }
  }
  return issues;
}

const INVALID_DB_CHARS = /[/\\. "$*<>:|?]/;

export function validateDatabaseName(name: string): string | undefined {
  if (!name || name.trim() === '') return 'Database name is required';
  if (name.length > 63) return 'Database name must be at most 63 characters';
  if (INVALID_DB_CHARS.test(name) || name.includes('\0')) return 'Database name contains invalid characters';
  return undefined;
}

export function validateCollectionName(name: string): string | undefined {
  if (!name || name.trim() === '') return 'Collection name is required';
  if (name.includes('$')) return 'Collection name cannot contain "$"';
  if (name.includes('\0')) return 'Collection name cannot contain null bytes';
  if (name.startsWith('system.')) return 'Collection names starting with "system." are reserved';
  if (Buffer.byteLength(name) > 235) return 'Collection name is too long';
  return undefined;
}
