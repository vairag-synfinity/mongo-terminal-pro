import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BackupManager } from '../../src/backup/backup-manager.js';
import { BackupHistory } from '../../src/backup/backup-history.js';
import {
  ARCHIVE_MAGIC,
  parseDumpCounts,
  verifyArchiveBackup,
  verifyDirectoryBackup,
} from '../../src/backup/backup-validator.js';
import { writeToolConfig } from '../../src/backup/database-tools.js';
import { RestoreManager, mapNamespace } from '../../src/backup/restore-manager.js';
import { ConnectionProfileSchema } from '../../src/connection/connection-types.js';
import { pipelineToStages, validatePipeline } from '../../src/database/aggregation-manager.js';
import { filterAndSortCollections, type CollectionSummary } from '../../src/database/collection-manager.js';
import { keysetDirection } from '../../src/database/document-manager.js';
import { classifyIndex, parseIndexKeys } from '../../src/database/index-manager.js';
import { parseQuery } from '../../src/database/query-manager.js';
import { analyzeDocuments, bsonTypeName } from '../../src/database/schema-analyzer.js';
import { PermissionManager } from '../../src/security/permission-manager.js';
import { BSON, Decimal128, ObjectId } from '../../src/utils/bson.js';
import { tmpDir, tmpPaths } from '../helpers/tmp.js';

const LIMITS = { resultLimit: 100, timeoutMs: 1000 };

describe('query validation', () => {
  it('parses a find with projection, sort and limits', () => {
    const q = parseQuery(
      {
        database: 'd',
        collection: 'c',
        operation: 'find',
        filter: '{ status: "active", age: { $gte: 18 } }',
        projection: '{ name: 1 }',
        sort: '{ age: -1 }',
        limit: 5,
        skip: 10,
      },
      LIMITS,
    );
    expect(q.filter).toEqual({ status: 'active', age: { $gte: 18 } });
    expect(q.sort).toEqual({ age: -1 });
    expect(q.limit).toBe(5);
    expect(q.skip).toBe(10);
    expect(q.permission).toBeUndefined();
  });

  it('caps limits and defaults 0 to the configured maximum', () => {
    expect(
      parseQuery({ database: 'd', collection: 'c', operation: 'find', filter: '{}', limit: 0 }, LIMITS).limit,
    ).toBe(100);
    const capped = parseQuery(
      { database: 'd', collection: 'c', operation: 'find', filter: '{}', limit: 5000 },
      LIMITS,
    );
    expect(capped.limit).toBe(100);
    expect(capped.warnings.join(' ')).toMatch(/reduced/);
  });

  it('collects all validation errors', () => {
    try {
      parseQuery(
        { database: '', collection: '', operation: 'find', filter: '{ bad', sort: '{ a: 2 }', limit: -1 },
        LIMITS,
      );
      expect.unreachable();
    } catch (e) {
      const details = (e as { details: string[] }).details;
      expect(details.join('\n')).toMatch(/Database is required/);
      expect(details.join('\n')).toMatch(/Filter:/);
      expect(details.join('\n')).toMatch(/Limit/);
    }
  });

  it('requires update operators and classifies destructive operations', () => {
    expect(() =>
      parseQuery(
        { database: 'd', collection: 'c', operation: 'updateOne', filter: '{}', update: '{ name: "x" }' },
        LIMITS,
      ),
    ).toThrow();
    expect(() =>
      parseQuery(
        {
          database: 'd',
          collection: 'c',
          operation: 'updateOne',
          filter: '{}',
          update: '{ $sett: { a: 1 } }',
        },
        LIMITS,
      ),
    ).toThrow();
    const many = parseQuery(
      { database: 'd', collection: 'c', operation: 'updateMany', filter: '{}', update: '{ $set: { a: 1 } }' },
      LIMITS,
    );
    expect(many.permission?.risk).toBe('destructive');
    expect(many.affectsAll).toBe(true);
    expect(many.warnings.join(' ')).toMatch(/EVERY document/);
    const pipelineUpdate = parseQuery(
      {
        database: 'd',
        collection: 'c',
        operation: 'updateOne',
        filter: '{ a: 1 }',
        update: '[{ $set: { b: "$a" } }]',
      },
      LIMITS,
    );
    expect(Array.isArray(pipelineUpdate.update)).toBe(true);
    const del = parseQuery({ database: 'd', collection: 'c', operation: 'deleteMany', filter: '{}' }, LIMITS);
    expect(del.permission?.risk).toBe('destructive');
  });

  it('warns about server-side JavaScript', () => {
    expect(
      parseQuery(
        { database: 'd', collection: 'c', operation: 'find', filter: '{ $where: "this.a > 1" }' },
        LIMITS,
      ).warnings.join(' '),
    ).toMatch(/\$where/);
  });

  it('requires a distinct field', () => {
    expect(() =>
      parseQuery({ database: 'd', collection: 'c', operation: 'distinct', filter: '{}' }, LIMITS),
    ).toThrow();
  });
});

describe('aggregation pipeline validation', () => {
  it('builds a pipeline from stages and skips disabled ones', () => {
    const v = validatePipeline([
      { operator: '$match', body: '{ status: "A" }' },
      { operator: '$group', body: '{ _id: "$city", n: { $sum: 1 } }' },
      { operator: '$sort', body: '{ n: -1 }', enabled: false },
      { operator: '$limit', body: '10' },
    ]);
    expect(v.errors).toEqual([]);
    expect(v.pipeline).toEqual([
      { $match: { status: 'A' } },
      { $group: { _id: '$city', n: { $sum: 1 } } },
      { $limit: 10 },
    ]);
    expect(v.writesData).toBe(false);
  });

  it('validates each supported stage', () => {
    const cases: [string, string, RegExp][] = [
      ['$limit', '0', /positive integer/],
      ['$skip', '-1', /non-negative/],
      ['$count', '"$bad"', /field name/],
      ['$group', '{ n: 1 }', /requires "_id"/],
      ['$lookup', '{ from: "x" }', /requires "as"/],
      ['$unwind', '"items"', /must start with "\$"/],
      ['$facet', '{ a: { $match: {} } }', /array of stages/],
      ['$bucket', '{ groupBy: "$a", boundaries: [1] }', /at least two/],
      ['$replaceRoot', '{}', /newRoot/],
      ['$sort', '{ a: 2 }', /1 or -1/],
      ['$project', '{}', /at least one/],
      ['$nope', '{}', /unknown stage/],
    ];
    for (const [operator, body, re] of cases) {
      expect(validatePipeline([{ operator, body }]).errors.join(' '), operator).toMatch(re);
    }
  });

  it('flags $out/$merge as writes and requires them last', () => {
    const v = validatePipeline([
      { operator: '$out', body: '"target"' },
      { operator: '$match', body: '{}' },
    ]);
    expect(v.writesData).toBe(true);
    expect(v.errors.join(' ')).toMatch(/last stage/);
  });

  it('warns when nothing bounds the pipeline', () => {
    expect(validatePipeline([{ operator: '$group', body: '{ _id: null }' }]).warnings.join(' ')).toMatch(
      /scan the whole collection/,
    );
  });

  it('converts raw pipelines back to builder stages losslessly', () => {
    const stages = pipelineToStages([{ $match: { _id: new ObjectId('65a000000000000000000001') } }]);
    expect(stages[0]?.operator).toBe('$match');
    const v = validatePipeline(stages);
    expect(v.errors).toEqual([]);
    expect((v.pipeline[0]?.$match as { _id: ObjectId })._id.toHexString()).toBe('65a000000000000000000001');
    expect(() => pipelineToStages([{ $a: 1, $b: 2 }])).toThrow(/exactly one/);
  });
});

describe('schema analysis', () => {
  it('infers field paths, types and frequencies', () => {
    const fields = analyzeDocuments([
      {
        _id: new ObjectId(),
        name: 'a',
        age: 1,
        tags: ['x'],
        address: { city: 'P' },
        price: Decimal128.fromString('1'),
      },
      { _id: new ObjectId(), name: 'b', age: 1.5, tags: [{ k: 1 }] },
    ]);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    expect(fields[0]?.path).toBe('_id');
    expect(byPath.age?.types).toEqual({ Int: 1, Double: 1 });
    expect(byPath['address.city']?.probability).toBe(0.5);
    expect(byPath['tags[]']?.types).toEqual({ String: 1 });
    expect(byPath['tags[].k']).toBeDefined();
    expect(byPath.price?.types).toEqual({ Decimal128: 1 });
  });

  it('names BSON types', () => {
    expect(bsonTypeName(null)).toBe('Null');
    expect(bsonTypeName(new Date())).toBe('Date');
    expect(bsonTypeName(new ObjectId())).toBe('ObjectId');
  });
});

describe('indexes and pagination helpers', () => {
  it('classifies index types', () => {
    expect(classifyIndex({ a: 1 }, {})).toBe('single');
    expect(classifyIndex({ a: 1, b: -1 }, {})).toBe('compound');
    expect(classifyIndex({ _fts: 'text', _ftsx: 1 }, {})).toBe('text');
    expect(classifyIndex({ loc: '2dsphere' }, {})).toBe('geo');
    expect(classifyIndex({ h: 'hashed' }, {})).toBe('hashed');
    expect(classifyIndex({ '$**': 1 }, {})).toBe('wildcard');
    expect(classifyIndex({ createdAt: 1 }, { expireAfterSeconds: 60 })).toBe('ttl');
  });

  it('parses index keys', () => {
    expect(parseIndexKeys('{ email: 1, at: -1 }')).toEqual({ email: 1, at: -1 });
    expect(() => parseIndexKeys('{}')).toThrow(/at least one/);
    expect(() => parseIndexKeys('{ a: 2 }')).toThrow(/must be 1, -1/);
  });

  it('uses keyset pagination only for _id sorts', () => {
    expect(keysetDirection(undefined)).toBe(1);
    expect(keysetDirection({ _id: -1 })).toBe(-1);
    expect(keysetDirection({ age: 1 })).toBeUndefined();
    expect(keysetDirection({ _id: 1, age: 1 })).toBeUndefined();
  });

  it('filters and sorts collection lists', () => {
    const list: CollectionSummary[] = [
      {
        name: 'b',
        type: 'collection',
        options: {},
        readOnly: false,
        capped: false,
        count: 5,
        countIsEstimate: true,
        storageSize: 10,
      },
      { name: 'a', type: 'view', options: {}, readOnly: true, capped: false, countIsEstimate: true },
      {
        name: 'c',
        type: 'collection',
        options: {},
        readOnly: false,
        capped: false,
        count: 50,
        countIsEstimate: true,
        storageSize: 5,
      },
    ];
    expect(filterAndSortCollections(list, {}).map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(filterAndSortCollections(list, { sort: 'count', descending: true }).map((c) => c.name)).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(filterAndSortCollections(list, { types: ['view'] }).map((c) => c.name)).toEqual(['a']);
    expect(filterAndSortCollections(list, { search: 'B' }).map((c) => c.name)).toEqual(['b']);
  });
});

async function writeDump(dir: string, db: string, coll: string, count: number, gzip = false): Promise<void> {
  const dbDir = path.join(dir, db);
  await fs.mkdir(dbDir, { recursive: true });
  const buf = Buffer.concat(Array.from({ length: count }, (_, i) => Buffer.from(BSON.serialize({ i }))));
  const bsonFile = path.join(dbDir, `${coll}.bson${gzip ? '.gz' : ''}`);
  if (gzip)
    await pipeline(Readable.from([buf]), createGzip(), (await import('node:fs')).createWriteStream(bsonFile));
  else await fs.writeFile(bsonFile, buf);
  await fs.writeFile(path.join(dbDir, `${coll}.metadata.json${gzip ? '.gz' : ''}`), '{}');
}

describe('backup verification', () => {
  it('parses mongodump counts (with and without backticks)', () => {
    const counts = parseDumpCounts(
      'x\tdone dumping `shop.users` (12 documents)\ny\tdone dumping shop.orders (1 document)\n',
    );
    expect(Object.fromEntries(counts)).toEqual({ 'shop.users': 12, 'shop.orders': 1 });
  });

  it('verifies directory dumps against reported counts', async () => {
    const dir = tmpDir();
    await writeDump(dir, 'shop', 'users', 25);
    await writeDump(dir, 'shop', 'orders', 3, true);
    const ok = await verifyDirectoryBackup(
      dir,
      new Map([
        ['shop.users', 25],
        ['shop.orders', 3],
      ]),
    );
    expect(ok.ok).toBe(true);
    expect(ok.totalDocuments).toBe(28);
    const mismatch = await verifyDirectoryBackup(
      dir,
      new Map([
        ['shop.users', 26],
        ['shop.missing', 1],
      ]),
    );
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.join(' ')).toMatch(/expected 26/);
    expect(mismatch.errors.join(' ')).toMatch(/missing from the backup/);
    expect((await verifyDirectoryBackup(path.join(dir, 'nope'))).ok).toBe(false);
  });

  it('detects missing metadata and corrupt BSON', async () => {
    const dir = tmpDir();
    await writeDump(dir, 'db', 'c', 2);
    await fs.rm(path.join(dir, 'db', 'c.metadata.json'));
    expect((await verifyDirectoryBackup(dir)).errors.join(' ')).toMatch(/metadata/);
    await fs.writeFile(path.join(dir, 'db', 'c.bson'), Buffer.from([1, 2, 3, 4, 5, 6]));
    expect((await verifyDirectoryBackup(dir)).ok).toBe(false);
  });

  it('verifies archive magic numbers and gzip integrity', async () => {
    const dir = tmpDir();
    const good = path.join(dir, 'a.archive');
    const header = Buffer.alloc(8);
    header.writeUInt32LE(ARCHIVE_MAGIC, 0);
    await fs.writeFile(good, header);
    expect((await verifyArchiveBackup(good, false)).ok).toBe(true);
    const bad = path.join(dir, 'b.archive');
    await fs.writeFile(bad, Buffer.from('not an archive'));
    expect((await verifyArchiveBackup(bad, false)).ok).toBe(false);
    const corruptGz = path.join(dir, 'c.archive.gz');
    await fs.writeFile(corruptGz, Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]));
    expect((await verifyArchiveBackup(corruptGz, true)).ok).toBe(false);
  });
});

describe('Database Tools integration (no subprocess)', () => {
  const now = new Date().toISOString();
  const profile = ConnectionProfileSchema.parse({
    id: 'id1',
    name: 'My Server',
    uri: 'mongodb://db:27017/',
    username: 'admin',
    createdAt: now,
    updatedAt: now,
  });

  it('writes credentials to a private, temporary --config file', async () => {
    const cfg = await writeToolConfig(profile, 'p"a\\ss:w0rd');
    const text = await fs.readFile(cfg.file, 'utf8');
    expect(text).toContain('uri: "mongodb://admin@db:27017/"');
    expect(text).toContain('password: "p\\"a\\\\ss:w0rd"');
    if (process.platform !== 'win32') expect(statSync(cfg.file).mode & 0o777).toBe(0o600);
    await cfg.cleanup();
    await expect(fs.stat(cfg.file)).rejects.toThrow();
  });

  it('never puts the password in mongodump/mongorestore arguments', () => {
    const backup = new BackupManager(new BackupHistory(tmpPaths()));
    const args = backup.buildArgs('/tmp/cfg.yaml', '/out/x', {
      database: 'shop',
      collection: 'users',
      gzip: true,
      archive: false,
      outputDir: '/out',
    });
    expect(args).toEqual([
      '--config',
      '/tmp/cfg.yaml',
      '--db',
      'shop',
      '--collection',
      'users',
      '--gzip',
      '--out',
      '/out/x',
    ]);
    const archiveArgs = backup.buildArgs('/c', '/out/a.archive.gz', {
      gzip: true,
      archive: true,
      outputDir: '/out',
    });
    expect(archiveArgs).toContain('--archive=/out/a.archive.gz');
    const target = backup.buildTarget(profile, {
      database: 'shop',
      gzip: true,
      archive: true,
      outputDir: '/backups',
    });
    expect(target).toMatch(/My_Server[\\/].*shop\.archive\.gz$/);

    const restore = new RestoreManager(new BackupHistory(tmpPaths()), new PermissionManager());
    const rargs = restore.buildArgs(
      '/c',
      { path: '/dump', layout: 'directory', gzip: true, namespaces: [] },
      { path: '/dump', drop: true, fromDatabase: 'a', toDatabase: 'b', nsInclude: ['a.users'] },
    );
    expect(rargs).toEqual([
      '--config',
      '/c',
      '--gzip',
      '--drop',
      '--nsInclude',
      'a.users',
      '--nsFrom',
      'a.*',
      '--nsTo',
      'b.*',
      '--dir=/dump',
    ]);
    expect(mapNamespace({ db: 'a', collection: 'x' }, 'a', 'b')).toBe('b.x');
  });

  it('restore requires write permission unless dry-run', async () => {
    const restore = new RestoreManager(new BackupHistory(tmpPaths()), new PermissionManager(profile));
    await expect(restore.run(profile, undefined, { path: '/nonexistent', drop: false })).rejects.toThrow(
      /requires write access/,
    );
  });
});
