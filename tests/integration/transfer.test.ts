import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Application } from '../../src/core/application.js';
import { ExportManager } from '../../src/transfer/export-manager.js';
import { ImportManager } from '../../src/transfer/import-manager.js';
import { bsonType, Decimal128, Long, ObjectId } from '../../src/utils/bson.js';
import { fileTmpDir, fileTmpPaths } from '../helpers/tmp.js';
import {
  adminClient,
  dropTestDatabases,
  integrationEnabled,
  TEST_PASSWORD,
  testProfile,
  uniqueDbName,
} from './env.js';

const enabled = integrationEnabled();

describe.skipIf(!enabled)('MongoDB integration: streaming import / export', () => {
  const db = uniqueDbName('xfer');
  let admin: MongoClient;
  let app: Application;
  let dir: string;
  const N = 12_000;

  beforeAll(async () => {
    admin = await adminClient();
    const coll = admin.db(db).collection('source');
    for (let start = 0; start < N; start += 2000) {
      await coll.insertMany(
        Array.from({ length: 2000 }, (_, k) => {
          const i = start + k;
          return {
            _id: new ObjectId(),
            i,
            big: Long.fromString(`90071992547409${String(i).padStart(5, '0')}`),
            price: Decimal128.fromString(`${i}.25`),
            at: new Date(Date.UTC(2030, 0, 1) + i * 1000),
            nested: { tag: `t${i % 7}` },
            list: [i, `s${i}`],
          };
        }),
      );
    }
    process.env.MTP_DISABLE_KEYRING = '1';
    app = await Application.create({ paths: fileTmpPaths(), logging: false });
    await app.connect(testProfile(), TEST_PASSWORD);
    dir = fileTmpDir();
  });

  afterAll(async () => {
    await app?.shutdown();
    await dropTestDatabases(admin, [db]);
    await admin?.close();
  });

  const exporter = () => new ExportManager(app.connectionManager.getClient());
  const importer = () => new ImportManager(app.connectionManager.getClient(), app.permissions);

  for (const [format, layout, jsonMode] of [
    ['json', 'array', 'relaxed'],
    ['json', 'jsonl', 'canonical'],
    ['bson', undefined, undefined],
  ] as const) {
    it(`round-trips ${N} documents through ${format}${layout ? `/${layout}/${jsonMode}` : ''} preserving BSON types`, async () => {
      const file = path.join(
        dir,
        `source-${format}-${layout ?? 'raw'}.${format === 'json' ? (layout === 'jsonl' ? 'jsonl' : 'json') : 'bson'}`,
      );
      let progressEvents = 0;
      const summary = await exporter().run({
        database: db,
        collection: 'source',
        format,
        output: file,
        batchSize: 500,
        jsonLayout: layout,
        jsonMode,
        onProgress: () => progressEvents++,
      });
      expect(summary.totalDocuments).toBe(N);
      expect(summary.files[0]?.bytes).toBe((await fs.stat(file)).size);
      expect(progressEvents).toBeGreaterThan(0);

      app.enableWrites();
      const target = `copy_${format}_${layout ?? 'raw'}`;
      const result = await importer().run({
        file,
        database: db,
        collection: target,
        mode: 'insert',
        batchSize: 1000,
      });
      app.disableWrites();
      expect(result.aborted).toBe(false);
      expect(result.inserted).toBe(N);
      expect(result.invalid).toBe(0);
      const sample = await admin.db(db).collection(target).findOne({ i: 4321 });
      expect(bsonType(sample?._id)).toBe('ObjectId');
      expect(bsonType(sample?.price)).toBe('Decimal128');
      expect(String(sample?.price)).toBe('4321.25');
      expect(sample?.at).toBeInstanceOf(Date);
      expect(String(sample?.big)).toBe('9007199254740904321');
      expect(sample?.nested).toEqual({ tag: 't2' });
    });
  }

  it('keeps exact numeric BSON types (int, long, double, decimal) through BSON and canonical JSON', async () => {
    const { Double, Int32 } = await import('../../src/utils/bson.js');
    await admin
      .db(db)
      .collection('types')
      .insertOne({
        i32: new Int32(7),
        i64: Long.fromNumber(7),
        dbl: new Double(7),
        dec: Decimal128.fromString('7'),
      });
    for (const [format, jsonMode, ext] of [
      ['bson', undefined, 'bson'],
      ['json', 'canonical', 'json'],
    ] as const) {
      const file = path.join(dir, `types.${ext}`);
      await exporter().run({
        database: db,
        collection: 'types',
        format,
        jsonMode,
        output: file,
        overwrite: true,
        batchSize: 10,
      });
      app.enableWrites();
      const target = `types_${format}`;
      await importer().run({ file, database: db, collection: target, mode: 'insert', batchSize: 10 });
      app.disableWrites();
      const [types] = await admin
        .db(db)
        .collection(target)
        .aggregate([
          {
            $project: {
              _id: 0,
              i32: { $type: '$i32' },
              i64: { $type: '$i64' },
              dbl: { $type: '$dbl' },
              dec: { $type: '$dec' },
            },
          },
        ])
        .toArray();
      expect(types, format).toEqual({ i32: 'int', i64: 'long', dbl: 'double', dec: 'decimal' });
    }
  });

  it('exports filtered, sorted, limited CSV with selected fields and re-imports it', async () => {
    const file = path.join(dir, 'filtered.csv');
    const summary = await exporter().run({
      database: db,
      collection: 'source',
      format: 'csv',
      output: file,
      filter: { 'nested.tag': 't3' },
      sort: { i: -1 },
      limit: 50,
      fields: ['i', 'nested.tag', 'at'],
      batchSize: 100,
    });
    expect(summary.totalDocuments).toBe(50);
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n');
    expect(lines[0]).toBe('i,nested.tag,at');
    expect(lines).toHaveLength(51);
    app.enableWrites();
    const r = await importer().run({
      file,
      database: db,
      collection: 'from_csv',
      mode: 'insert',
      batchSize: 20,
    });
    app.disableWrites();
    expect(r.inserted).toBe(50);
    const doc = await admin
      .db(db)
      .collection('from_csv')
      .findOne({}, { sort: { i: -1 } });
    expect(typeof doc?.i).toBe('number');
    expect(doc?.nested).toEqual({ tag: 't3' });
    expect(doc?.at).toBeInstanceOf(Date);
  });

  it('exports selected documents by _id and whole databases', async () => {
    const ids = (
      await admin
        .db(db)
        .collection('source')
        .find({}, { projection: { _id: 1 }, limit: 3 })
        .toArray()
    ).map((d) => d._id);
    const sel = await exporter().run({
      database: db,
      collection: 'source',
      format: 'json',
      output: path.join(dir, 'selected.json'),
      ids,
      batchSize: 10,
    });
    expect(sel.totalDocuments).toBe(3);
    const whole = await exporter().run({
      database: db,
      format: 'json',
      output: path.join(dir, 'whole'),
      batchSize: 1000,
      jsonLayout: 'jsonl',
    });
    expect(whole.files.map((f) => f.collection)).toContain('source');
    expect(whole.completed).toBe(true);
  });

  it('never overwrites existing documents in insert mode; can skip duplicates; upserts explicitly', async () => {
    const file = path.join(dir, 'dups.json');
    const id = new ObjectId();
    await fs.writeFile(file, JSON.stringify([{ _id: { $oid: id.toHexString() }, v: 'new' }, { v: 'other' }]));
    await admin.db(db).collection('dups').insertOne({ _id: id, v: 'original' });
    app.enableWrites();
    const aborted = await importer().run({
      file,
      database: db,
      collection: 'dups',
      mode: 'insert',
      duplicates: 'abort',
      batchSize: 10,
    });
    expect(aborted.aborted).toBe(true);
    expect((await admin.db(db).collection('dups').findOne({ _id: id }))?.v).toBe('original');
    const skipped = await importer().run({
      file,
      database: db,
      collection: 'dups',
      mode: 'insert',
      duplicates: 'skip',
      batchSize: 10,
    });
    expect(skipped.skippedDuplicates).toBe(1);
    expect(skipped.inserted).toBe(1);
    expect((await admin.db(db).collection('dups').findOne({ _id: id }))?.v).toBe('original');
    const upserted = await importer().run({
      file: path.join(dir, 'dups.json'),
      database: db,
      collection: 'dups',
      mode: 'upsert',
      batchSize: 10,
      skipInvalid: true,
    });
    expect(upserted.matched).toBe(1);
    expect(upserted.modified).toBe(1);
    expect(upserted.invalid).toBe(1); // document without _id cannot be matched
    expect((await admin.db(db).collection('dups').findOne({ _id: id }))?.v).toBe('new');
    app.disableWrites();
  });

  it('validates the whole file first and writes nothing when records are invalid', async () => {
    const file = path.join(dir, 'invalid.jsonl');
    await fs.writeFile(file, '{"ok":1}\n{"ok":2}\nnot json\n{"$top":1}\n');
    app.enableWrites();
    const r = await importer().run({
      file,
      database: db,
      collection: 'invalid_target',
      mode: 'insert',
      batchSize: 1,
      errorReportPath: path.join(dir, 'errors.jsonl'),
    });
    expect(r.aborted).toBe(true);
    expect(r.invalid).toBe(2);
    expect(r.inserted).toBe(0);
    expect(await admin.db(db).collection('invalid_target').countDocuments()).toBe(0);
    expect((await fs.readFile(path.join(dir, 'errors.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
    const skip = await importer().run({
      file,
      database: db,
      collection: 'invalid_target',
      mode: 'insert',
      batchSize: 1,
      skipInvalid: true,
    });
    expect(skip.inserted).toBe(2);
    const dry = await importer().run({
      file,
      database: db,
      collection: 'never',
      mode: 'insert',
      batchSize: 1,
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(await admin.db(db).collection('never').countDocuments()).toBe(0);
    app.disableWrites();
  });

  it('requires write access to import', async () => {
    await expect(
      importer().run({
        file: path.join(dir, 'dups.json'),
        database: db,
        collection: 'x',
        mode: 'insert',
        batchSize: 1,
      }),
    ).rejects.toThrow(/requires write access/);
  });

  it('cancels long exports and removes partial files', async () => {
    const ac = new AbortController();
    const file = path.join(dir, 'cancelled.json');
    const run = exporter().run({
      database: db,
      collection: 'source',
      format: 'json',
      output: file,
      batchSize: 100,
      signal: ac.signal,
      onProgress: (p) => p.processed > 200 && ac.abort(),
    });
    await expect(run).rejects.toThrow(/cancelled/i);
    await expect(fs.stat(file)).rejects.toThrow();
    await expect(fs.stat(`${file}.partial`)).rejects.toThrow();
  });
});
