import { describe, expect, it } from 'vitest';
import type { Decimal128, Long, ObjectId } from '../../src/utils/bson.js';
import { bsonType } from '../../src/utils/bson.js';
import {
  parseMongoArray,
  parseMongoObject,
  parseMongoValue,
  ParseError,
  validateCollectionName,
  validateDatabaseName,
  validateDocument,
} from '../../src/utils/validation.js';

describe('parseMongoValue (shell / Extended JSON parser)', () => {
  it('parses strict JSON', () => {
    expect(parseMongoValue('{"a": 1, "b": [true, null, "x"], "c": {"d": -1.5e2}}')).toEqual({
      a: 1,
      b: [true, null, 'x'],
      c: { d: -150 },
    });
  });

  it('accepts shell conveniences: unquoted keys, single quotes, trailing commas, comments', () => {
    const value = parseMongoValue(`{
      status: 'active', // inline comment
      age: { $gte: 18, },
      /* block */ "address.city": "Pune",
    }`);
    expect(value).toEqual({ status: 'active', age: { $gte: 18 }, 'address.city': 'Pune' });
  });

  it('understands BSON constructors without evaluating code', () => {
    const v = parseMongoObject(
      `{ _id: ObjectId("65a000000000000000000001"), at: ISODate("2024-01-02T03:04:05Z"), n: NumberLong("9007199254740993"),
         d: NumberDecimal("19.99"), i: NumberInt(5), u: UUID("0e9a8f6c-7b8a-4b8e-9c7f-2a6f1b9d0c11"), re: /^ab+c/i, t: Timestamp(10, 2), mk: MinKey() }`,
    );
    expect(bsonType(v._id)).toBe('ObjectId');
    expect((v._id as ObjectId).toHexString()).toBe('65a000000000000000000001');
    expect(v.at).toBeInstanceOf(Date);
    expect((v.at as Date).toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect((v.n as Long).toString()).toBe('9007199254740993');
    expect((v.d as Decimal128).toString()).toBe('19.99');
    expect(bsonType(v.i)).toBe('Int32');
    expect(bsonType(v.u)).toBe('Binary');
    expect(bsonType(v.re)).toBe('BSONRegExp');
    expect(bsonType(v.t)).toBe('Timestamp');
    expect(bsonType(v.mk)).toBe('MinKey');
  });

  it('accepts new Date() and Timestamp({ t, i })', () => {
    const v = parseMongoObject('{ a: new Date("2020-01-01"), t: Timestamp({ t: 5, i: 1 }) }');
    expect(v.a).toBeInstanceOf(Date);
    expect(bsonType(v.t)).toBe('Timestamp');
  });

  it('hydrates Extended JSON wrappers', () => {
    const v = parseMongoObject(
      '{"_id": {"$oid": "65a000000000000000000002"}, "n": {"$numberLong": "42"}, "d": {"$date": "2024-01-01T00:00:00Z"}}',
    );
    expect(bsonType(v._id)).toBe('ObjectId');
    expect(v.d).toBeInstanceOf(Date);
    expect(String(v.n)).toBe('42');
  });

  it('rejects code and unknown identifiers', () => {
    expect(() => parseMongoValue('{ a: process.exit(1) }')).toThrow(ParseError);
    expect(() => parseMongoValue('{ a: function() { return 1 } }')).toThrow(
      /Unknown identifier|Unexpected|Unsupported constructor/,
    );
    expect(() => parseMongoValue('{ a: active }')).toThrow(/Strings must be quoted/);
    expect(() => parseMongoValue('{ a: eval("1") }')).toThrow(/Unsupported constructor/);
  });

  it('blocks prototype pollution keys', () => {
    expect(() => parseMongoValue('{ "__proto__": { "polluted": true } }')).toThrow(/__proto__/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('reports line and column on syntax errors', () => {
    try {
      parseMongoValue('{\n  a: 1,\n  b: [1, 2\n}');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).line).toBe(4);
    }
  });

  it('validates invalid constructor arguments', () => {
    expect(() => parseMongoValue('ObjectId("nothex")')).toThrow();
    expect(() => parseMongoValue('ISODate("not a date")')).toThrow(/Invalid date/);
  });

  it('parseMongoObject / parseMongoArray enforce shapes', () => {
    expect(parseMongoObject('')).toEqual({});
    expect(() => parseMongoObject('[1]')).toThrow(/must be a JSON object/);
    expect(parseMongoArray('[{ $match: {} }]')).toEqual([{ $match: {} }]);
    expect(() => parseMongoArray('{}')).toThrow(/must be a JSON array/);
  });

  it('handles strings with escapes and unicode', () => {
    expect(parseMongoValue('"a\\"b\\\\c\\u00e9\\n"')).toBe('a"b\\cé\n');
    expect(parseMongoValue("'it\\'s'")).toBe("it's");
  });

  it('parses numbers including hex, negative and exponent forms', () => {
    expect(parseMongoValue('[0x1F, -2, .5, 1e3, +4]')).toEqual([31, -2, 0.5, 1000, 4]);
  });
});

describe('validateDocument', () => {
  it('accepts normal documents', () => {
    expect(validateDocument({ a: 1, b: { c: [1, 2, { d: new Date() }] } })).toEqual([]);
  });
  it('rejects non-objects and top-level $ keys', () => {
    expect(validateDocument([1])[0]?.message).toMatch(/object/);
    expect(validateDocument({ $set: { a: 1 } })[0]?.message).toMatch(/cannot start with "\$"/);
  });
  it('allows $ keys in nested positions (e.g. $ref-like structures are left to the server)', () => {
    expect(validateDocument({ a: { $x: 1 } })).toEqual([]);
  });
  it('rejects null bytes in keys, functions and bigint', () => {
    expect(validateDocument({ 'a\0b': 1 })[0]?.message).toMatch(/null bytes/);
    expect(validateDocument({ f: () => 1 })[0]?.message).toMatch(/Unsupported/);
    expect(validateDocument({ b: BigInt(1) })[0]?.message).toMatch(/BigInt/);
  });
  it('rejects documents above 16 MB', () => {
    const big = { s: 'x'.repeat(17 * 1024 * 1024) };
    expect(validateDocument(big)[0]?.message).toMatch(/16 MB/);
  });
  it('rejects excessive nesting', () => {
    let doc: Record<string, unknown> = {};
    const root = doc;
    for (let i = 0; i < 120; i++) {
      doc.n = {};
      doc = doc.n as Record<string, unknown>;
    }
    expect(validateDocument(root).some((i) => /Nesting/.test(i.message))).toBe(true);
  });
});

describe('name validation', () => {
  it('validates database names', () => {
    expect(validateDatabaseName('shop')).toBeUndefined();
    expect(validateDatabaseName('')).toMatch(/required/);
    expect(validateDatabaseName('a.b')).toMatch(/invalid/);
    expect(validateDatabaseName('a'.repeat(64))).toMatch(/63/);
  });
  it('validates collection names', () => {
    expect(validateCollectionName('users')).toBeUndefined();
    expect(validateCollectionName('a$b')).toMatch(/\$/);
    expect(validateCollectionName('system.users')).toMatch(/reserved/);
  });
});
