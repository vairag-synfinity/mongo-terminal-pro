import { createReadStream, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  BsonDocumentWriter,
  countBsonDocuments,
  readBsonDocuments,
} from '../../src/transfer/bson-handler.js';
import {
  csvCell,
  csvRecordToDocument,
  CsvDocumentWriter,
  convertCsvValue,
  inferCsvFields,
  inferCsvValue,
  previewCsv,
  readCsvRows,
} from '../../src/transfer/csv-handler.js';
import { extensionFor, validateExportPath } from '../../src/transfer/export-manager.js';
import {
  checkImportFile,
  detectFormat,
  validateImportDocument,
} from '../../src/transfer/import-validator.js';
import { previewImportFile } from '../../src/transfer/import-manager.js';
import {
  JsonDocumentWriter,
  readJsonDocuments,
  serializeJsonDocument,
  splitJsonValues,
  toPlainJson,
} from '../../src/transfer/json-handler.js';
import { ProgressTracker, progressFraction } from '../../src/transfer/transfer-progress.js';
import { BSON, bsonType, Decimal128, Long, ObjectId } from '../../src/utils/bson.js';
import { FIXTURES, tmpDir } from '../helpers/tmp.js';

/** Emits the text in tiny chunks to exercise chunk-boundary handling. */
function chunked(text: string | Buffer, size = 3): Readable {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
  const parts: Buffer[] = [];
  for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
  return Readable.from(parts);
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

async function streamToString(fn: (out: PassThrough) => Promise<void>): Promise<string> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  await fn(out);
  out.end();
  return Buffer.concat(chunks).toString('utf8');
}

describe('JSON streaming', () => {
  it('splits JSON arrays, JSON Lines and concatenated objects across tiny chunks', async () => {
    const array = await collect(splitJsonValues(chunked('[ {"a":1}, {"b":"}{"}, {"c":[1,{"d":2}]} ]')));
    expect(array.map((v) => JSON.parse(v.text))).toEqual([{ a: 1 }, { b: '}{' }, { c: [1, { d: 2 }] }]);
    const lines = await collect(splitJsonValues(chunked('{"a":1}\n{"a":2}\n\n{"a":3}\n', 2)));
    expect(lines).toHaveLength(3);
    expect(lines[2]?.line).toBe(4);
    const concat = await collect(splitJsonValues(chunked('{"a":"\\"}"} {"b":2}')));
    expect(concat.map((v) => JSON.parse(v.text))).toEqual([{ a: '"}' }, { b: 2 }]);
  });

  it('handles BOM and multi-byte characters split between chunks', async () => {
    const values = await collect(readJsonDocuments(chunked('﻿[{"name":"日本語 ✓"}]', 1)));
    expect(values[0]?.document).toEqual({ name: '日本語 ✓' });
  });

  it('parses Extended JSON into BSON types', async () => {
    const docs = await collect(readJsonDocuments(createReadStream(path.join(FIXTURES, 'docs.json'))));
    expect(docs).toHaveLength(2);
    const first = docs[0]?.document as Record<string, unknown>;
    expect(bsonType(first._id)).toBe('ObjectId');
    expect(String(first.n)).toBe('9007199254740993');
    expect(first.d).toBeInstanceOf(Date);
    expect(first.s).toBe('brace } in string " quote {');
  });

  it('reports structural errors clearly', async () => {
    await expect(collect(splitJsonValues(chunked('[{"a":1}, {"b":')))).rejects.toThrow(/end of file inside/);
    await expect(collect(splitJsonValues(chunked('[{"a":1}')))).rejects.toThrow(/missing closing/);
    await expect(collect(splitJsonValues(chunked('[1, 2]')))).rejects.toThrow(/Expected a JSON object/);
    await expect(collect(splitJsonValues(chunked('[{"a":1}] {"b":2}')))).rejects.toThrow(/after the closing/);
  });

  it('reads JSON Lines line by line so one bad line does not break others', async () => {
    const docs = await collect(
      readJsonDocuments(chunked('{"a":1}\n{"bad": \n{"c":3}\n["x"]\n'), { lines: true }),
    );
    expect(docs.map((d) => (d.document ? 'ok' : 'err'))).toEqual(['ok', 'err', 'ok', 'err']);
    expect(docs[1]?.line).toBe(2);
  });

  it('writes arrays and JSON Lines in each Extended JSON mode', async () => {
    const doc = {
      _id: new ObjectId('65a000000000000000000001'),
      n: Long.fromString('9007199254740993'),
      d: new Date('2024-01-01T00:00:00Z'),
      p: Decimal128.fromString('1.5'),
    };
    const arr = await streamToString(async (out) => {
      const w = new JsonDocumentWriter(out, 'array', 'relaxed');
      await w.begin();
      await w.write(doc);
      await w.write({ x: 1 });
      await w.end();
    });
    const parsed = JSON.parse(arr) as unknown[];
    expect(parsed).toHaveLength(2);
    expect(arr).toContain('"$oid":"65a000000000000000000001"');
    expect(serializeJsonDocument(doc, 'canonical')).toContain('"$numberLong":"9007199254740993"');
    const plain = JSON.parse(serializeJsonDocument(doc, 'plain'));
    expect(plain).toEqual({
      _id: '65a000000000000000000001',
      n: '9007199254740993',
      d: '2024-01-01T00:00:00.000Z',
      p: '1.5',
    });
    const jsonl = await streamToString(async (out) => {
      const w = new JsonDocumentWriter(out, 'jsonl', 'relaxed');
      await w.begin();
      await w.write({ a: 1 });
      await w.write({ a: 2 });
      await w.end();
    });
    expect(jsonl).toBe('{"a":1}\n{"a":2}\n');
    const empty = await streamToString(async (out) => {
      const w = new JsonDocumentWriter(out, 'array', 'relaxed');
      await w.begin();
      await w.end();
    });
    expect(JSON.parse(empty)).toEqual([]);
  });

  it('never loses Int64 precision in relaxed mode', () => {
    const text = serializeJsonDocument(
      {
        big: Long.fromString('9007199254740993'),
        small: Long.fromNumber(5),
        nested: [{ x: Long.fromString('-9223372036854775808') }],
      },
      'relaxed',
    );
    expect(text).toBe(
      '{"big":{"$numberLong":"9007199254740993"},"small":5,"nested":[{"x":{"$numberLong":"-9223372036854775808"}}]}',
    );
  });

  it('converts BSON values to plain JSON', () => {
    expect(toPlainJson({ a: [new Date(0)], b: Long.fromNumber(5) })).toEqual({
      a: ['1970-01-01T00:00:00.000Z'],
      b: 5,
    });
  });
});

describe('CSV', () => {
  it('infers types conservatively', () => {
    expect(inferCsvValue('42')).toBe(42);
    expect(inferCsvValue('00123')).toBe('00123');
    expect(inferCsvValue('3.5')).toBe(3.5);
    expect(inferCsvValue('true')).toBe(true);
    expect(inferCsvValue('2024-01-02T03:04:05Z')).toBeInstanceOf(Date);
    expect(inferCsvValue('2024-01-02')).toBe('2024-01-02');
    expect(inferCsvValue('+49 151 123')).toBe('+49 151 123');
    expect(bsonType(inferCsvValue('123456789012345678901'))).toBe('Long');
  });

  it('converts explicit types and reports errors', () => {
    expect(convertCsvValue('1', 'boolean')).toBe(true);
    expect(bsonType(convertCsvValue('65a000000000000000000001', 'objectId'))).toBe('ObjectId');
    expect(convertCsvValue('[1,2]', 'json')).toEqual([1, 2]);
    expect(() => convertCsvValue('abc', 'number')).toThrow(/not a number/);
    expect(() => convertCsvValue('1.5', 'int')).toThrow(/integer/);
  });

  it('maps records to nested documents and handles empty cells', () => {
    const rec = { name: 'Ada', 'address.city': 'Pune', age: '', skip: 'x' };
    expect(csvRecordToDocument(rec, undefined)).toEqual({
      name: 'Ada',
      address: { city: 'Pune' },
      skip: 'x',
    });
    expect(csvRecordToDocument(rec, undefined, { emptyValues: 'null' })).toEqual({
      name: 'Ada',
      address: { city: 'Pune' },
      age: null,
      skip: 'x',
    });
    const mapped = csvRecordToDocument(rec, [
      { source: 'name', target: 'profile.name', type: 'string' },
      { source: 'skip', target: 'skip', type: 'skip' },
    ]);
    expect(mapped).toEqual({ profile: { name: 'Ada' } });
    expect(() =>
      csvRecordToDocument({ a: '1' }, [{ source: 'a', target: '__proto__.x', type: 'string' }]),
    ).toThrow(/Invalid field/);
  });

  it('streams CSV files with quoted fields and BOM', async () => {
    const rows = await collect(
      readCsvRows(chunked('﻿name,note\n"Ada","has, comma"\n"Bob","line\nbreak"\n', 4)),
    );
    expect(rows.map((r) => r.record)).toEqual([
      { name: 'Ada', note: 'has, comma' },
      { name: 'Bob', note: 'line\nbreak' },
    ]);
    const preview = await previewCsv(createReadStream(path.join(FIXTURES, 'people.csv')), 1);
    expect(preview.headers).toEqual(['name', 'age', 'active', 'joined', 'tags', 'zip']);
    expect(preview.rows).toHaveLength(1);
  });

  it('writes CSV with flattened fields', async () => {
    const docs = [
      { _id: new ObjectId('65a000000000000000000001'), a: { b: 1 }, list: [1, 2], d: new Date(0) },
    ];
    const fields = inferCsvFields(docs);
    expect(fields).toEqual(['_id', 'a.b', 'list', 'd']);
    const csv = await streamToString(async (out) => {
      const w = new CsvDocumentWriter(out, fields);
      for (const d of docs) await w.write(d);
      await w.end();
    });
    expect(csv.trim().split('\n')).toEqual([
      '_id,a.b,list,d',
      '65a000000000000000000001,1,"[1,2]",1970-01-01T00:00:00.000Z',
    ]);
    expect(csvCell(null)).toBe('');
  });
});

describe('BSON', () => {
  it('round-trips documents and handles chunk boundaries', async () => {
    const docs = Array.from({ length: 50 }, (_, i) => ({ i, s: 'x'.repeat(i * 7), id: new ObjectId() }));
    const buf = Buffer.concat(docs.map((d) => Buffer.from(BSON.serialize(d))));
    const read = await collect(readBsonDocuments(chunked(buf, 13)));
    // Numbers keep their BSON wrapper types (Int32 here) so re-inserting is lossless.
    expect(bsonType(read[0]?.document?.i)).toBe('Int32');
    expect(read.map((r) => Number(r.document?.i))).toEqual(docs.map((d) => d.i));
    expect(await countBsonDocuments(chunked(buf, 5))).toEqual({ documents: 50, bytes: buf.length });
  });

  it('detects truncated and corrupt files', async () => {
    const buf = Buffer.from(BSON.serialize({ a: 1 }));
    await expect(collect(readBsonDocuments(chunked(buf.subarray(0, buf.length - 2))))).rejects.toThrow(
      /Truncated/,
    );
    const corrupt = Buffer.from(buf);
    corrupt.writeInt32LE(2, 0);
    await expect(collect(readBsonDocuments(chunked(corrupt)))).rejects.toThrow(/invalid document length/);
    const noTerminator = Buffer.from(buf);
    noTerminator[noTerminator.length - 1] = 1;
    await expect(countBsonDocuments(chunked(noTerminator))).rejects.toThrow(/null-terminated/);
  });

  it('writes BSON files', async () => {
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    const w = new BsonDocumentWriter(out);
    await w.write({ a: 1 });
    await w.end();
    out.end();
    expect(BSON.deserialize(Buffer.concat(chunks))).toEqual({ a: 1 });
  });
});

describe('import validation and preview', () => {
  it('detects formats from extensions', () => {
    expect(detectFormat('a.JSON')).toBe('json');
    expect(detectFormat('a.ndjson.gz')).toBe('json');
    expect(detectFormat('a.csv')).toBe('csv');
    expect(detectFormat('dump/users.bson')).toBe('bson');
    expect(detectFormat('a.txt')).toBeUndefined();
  });

  it('checks files before reading', async () => {
    await expect(checkImportFile('/definitely/not/here.json')).rejects.toThrow(/not found/);
    await expect(checkImportFile(FIXTURES)).rejects.toThrow(/Not a regular file/);
    const ok = await checkImportFile(`"${path.join(FIXTURES, 'docs.json')}"`);
    expect(ok.format).toBe('json');
    expect(ok.gzip).toBe(false);
  });

  it('validates documents including upsert keys', () => {
    expect(validateImportDocument({ a: 1 }, 0, 'line 1', ['email'])[0]?.message).toMatch(/upsert key/);
    expect(validateImportDocument({ $bad: 1 }, 3)[0]?.index).toBe(3);
  });

  it('previews only the first records', async () => {
    const p = await previewImportFile(path.join(FIXTURES, 'people.csv'), undefined, 1);
    expect(p.format).toBe('csv');
    expect(p.documents).toHaveLength(1);
    expect(p.documents[0]).toMatchObject({ name: 'Ada', age: 36, active: true });
    const j = await previewImportFile(path.join(FIXTURES, 'docs.json'), undefined, 1);
    expect(j.documents).toHaveLength(1);
  });
});

describe('export path validation', () => {
  it('refuses existing files unless overwrite is confirmed', async () => {
    const dir = tmpDir();
    const file = path.join(dir, 'out.json');
    await fs.writeFile(file, 'x');
    await expect(validateExportPath(file)).rejects.toThrow(/already exists/);
    expect(await validateExportPath(file, { overwrite: true })).toBe(file);
    await expect(validateExportPath(dir)).rejects.toThrow(/is a directory/);
    expect(await validateExportPath(path.join(dir, 'new', 'deeper.json'))).toBe(
      path.join(dir, 'new', 'deeper.json'),
    );
  });

  it('refuses system directories and empty paths', async () => {
    await expect(validateExportPath('')).rejects.toThrow(/required/);
    if (process.platform !== 'win32')
      await expect(validateExportPath('/etc/passwd-export.json')).rejects.toThrow(/system directory/);
  });

  it('picks extensions per format', () => {
    expect(extensionFor('json', 'jsonl')).toBe('.jsonl');
    expect(extensionFor('bson')).toBe('.bson');
  });
});

describe('progress tracking', () => {
  it('computes fractions and throttles callbacks', () => {
    const events: number[] = [];
    const t = new ProgressTracker(
      (p) => events.push(p.processed),
      'writing',
      100,
      undefined,
      false,
      1_000_000,
    );
    t.processed = 10;
    t.tick();
    t.processed = 20;
    t.tick();
    t.tick(true);
    expect(events).toEqual([10, 20]);
    expect(progressFraction(t.snapshot())).toBeCloseTo(0.2);
    expect(progressFraction({ ...t.snapshot(), total: undefined, totalBytes: 200, bytes: 50 })).toBeCloseTo(
      0.25,
    );
    expect(readFileSync).toBeDefined();
  });
});
