import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionProfileSchema } from '../../src/connection/connection-types.js';
import { ReadOnlyError, ValidationError } from '../../src/core/error-handler.js';
import { Operations, PermissionManager } from '../../src/security/permission-manager.js';
import { CopyManager, listUserDatabases } from '../../src/transfer/copy-manager.js';
import { ExportManager } from '../../src/transfer/export-manager.js';
import {
  FolderImportManager,
  collectionNameFromFile,
  planFolderImport,
} from '../../src/transfer/folder-import.js';
import { Long } from '../../src/utils/bson.js';
import { fileTmpDir, tmpDir } from '../helpers/tmp.js';
import {
  adminClient,
  dropTestDatabases,
  integrationEnabled,
  TEST_URI,
  testProfile,
  uniqueDbName,
} from './env.js';

const enabled = integrationEnabled();

describe.skipIf(!enabled)('Copy / migrate, export all databases, folder import', () => {
  const src = uniqueDbName('src');
  const dst = uniqueDbName('dst');
  const dst2 = uniqueDbName('dst2');
  const folderDb = uniqueDbName('fold');
  let admin: MongoClient;
  // A second, independent client simulates "another connection".
  let other: MongoClient;
  let dir: string;

  beforeAll(async () => {
    admin = await adminClient();
    other = new MongoClient(TEST_URI as string);
    await other.connect();
    const d = admin.db(src);
    await d.collection('users').insertMany(
      Array.from({ length: 2500 }, (_, i) => ({
        i,
        big: Long.fromString(`900719925474099${i % 10}`),
        name: `u${i}`,
      })),
    );
    await d.collection('users').createIndex({ name: 1 }, { unique: true });
    await d.collection('orders').insertMany([{ o: 1 }, { o: 2 }]);
    await d.createCollection('log', { capped: true, size: 65536 });
    await d.createCollection('validated', { validator: { $jsonSchema: { required: ['x'] } } });
    await d.createCollection('bigUsers', { viewOn: 'users', pipeline: [{ $match: { i: { $gt: 2000 } } }] });
    dir = fileTmpDir();
  });

  afterAll(async () => {
    await dropTestDatabases(admin, [src, dst, dst2, folderDb]);
    await other?.close();
    await admin?.close();
  });

  it('copies a whole database with options, views, indexes and exact types', async () => {
    const summary = await new CopyManager().run({
      source: { client: admin, database: src },
      target: { client: admin, database: dst },
      batchSize: 300,
    });
    expect(summary.aborted).toBe(false);
    expect(summary.totalDocuments).toBe(2502);
    const t = admin.db(dst);
    expect(await t.collection('users').countDocuments()).toBe(2500);
    expect((await t.collection('users').indexes()).some((i) => i.name === 'name_1' && i.unique)).toBe(true);
    expect(await t.collection('log').isCapped()).toBe(true);
    const infos = await t.listCollections().toArray();
    expect(infos.find((c) => c.name === 'bigUsers')?.type).toBe('view');
    expect(
      (infos.find((c) => c.name === 'validated') as { options?: { validator?: unknown } })?.options
        ?.validator,
    ).toBeDefined();
    const [types] = await t
      .collection('users')
      .aggregate([{ $limit: 1 }, { $project: { _id: 0, big: { $type: '$big' }, i: { $type: '$i' } } }])
      .toArray();
    expect(types).toEqual({ big: 'long', i: 'int' });
  });

  it('never overwrites by default; skip and replace are explicit', async () => {
    const run = (duplicates: 'abort' | 'skip' | 'replace') =>
      new CopyManager().run({
        source: { client: admin, database: src },
        target: { client: admin, database: dst },
        collections: ['orders'],
        batchSize: 10,
        duplicates,
      });
    await admin
      .db(dst)
      .collection('orders')
      .updateMany({}, { $set: { changed: true } });
    const aborted = await run('abort');
    expect(aborted.aborted).toBe(true);
    expect(aborted.abortReason).toMatch(/duplicate _id/);
    expect(await admin.db(dst).collection('orders').countDocuments({ changed: true })).toBe(2);
    expect((await run('skip')).collections[0]?.skippedDuplicates).toBe(2);
    expect(await admin.db(dst).collection('orders').countDocuments({ changed: true })).toBe(2);
    expect((await run('replace')).collections[0]?.replaced).toBe(2);
    expect(await admin.db(dst).collection('orders').countDocuments({ changed: true })).toBe(0);
  });

  it('copies selected collections to another connection and can drop the target first', async () => {
    await other.db(dst2).collection('users').insertOne({ stale: true });
    const s = await new CopyManager().run({
      source: { client: admin, database: src },
      target: { client: other, database: dst2 },
      collections: ['users'],
      dropTarget: true,
      copyIndexes: false,
      batchSize: 1000,
    });
    expect(s.collections.map((c) => c.collection)).toEqual(['users']);
    expect(await other.db(dst2).collection('users').countDocuments({ stale: true })).toBe(0);
    expect(await other.db(dst2).collection('users').countDocuments()).toBe(2500);
    expect((await other.db(dst2).collection('users').indexes()).length).toBe(1);
  });

  it('refuses to copy a database onto itself, into system databases or unknown collections', async () => {
    const cm = new CopyManager();
    await expect(
      cm.run({
        source: { client: admin, database: src },
        target: { client: admin, database: src },
        batchSize: 1,
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      cm.run({
        source: { client: admin, database: src },
        target: { client: other, database: 'admin' },
        batchSize: 1,
      }),
    ).rejects.toThrow(/system database/);
    await expect(
      cm.run({
        source: { client: admin, database: src },
        target: { client: admin, database: dst },
        collections: ['nope'],
        batchSize: 1,
      }),
    ).rejects.toThrow(/Not found/);
  });

  it('checks permissions for another target connection', () => {
    const now = new Date().toISOString();
    const mk = (o: object) =>
      ConnectionProfileSchema.parse({
        id: 'x',
        name: 'Target',
        uri: 'mongodb://h/',
        createdAt: now,
        updatedAt: now,
        ...o,
      });
    const pm = new PermissionManager(testProfile());
    expect(pm.checkTarget(Operations.copyData, mk({}))).toEqual({ allowed: true, confirmation: 'confirm' });
    expect(pm.checkTarget(Operations.copyDrop, mk({})).confirmation).toBe('type-name');
    expect(pm.checkTarget(Operations.copyData, mk({ production: true })).confirmation).toBe('type-name');
    expect(pm.checkTarget(Operations.copyData, mk({ readOnlyLocked: true })).allowed).toBe(false);
  });

  it('exports all databases into one folder per database and re-imports a folder', async () => {
    const out = path.join(dir, 'all');
    const summary = await new ExportManager(admin).run({
      database: '',
      allDatabases: true,
      format: 'json',
      jsonMode: 'canonical',
      output: out,
      batchSize: 500,
    });
    expect(summary.files.some((f) => f.database === src && f.collection === 'users')).toBe(true);
    expect(summary.files.every((f) => !['admin', 'local', 'config'].includes(f.database ?? ''))).toBe(true);
    expect(summary.skipped.some((s) => s.collection === `${src}.bigUsers`)).toBe(true);
    expect(await listUserDatabases(admin)).toContain(src);

    const plan = await planFolderImport({ dir: path.join(out, src), database: folderDb });
    expect(plan.map((p) => p.collection).sort()).toEqual(['log', 'orders', 'users', 'validated']);
    const perms = new PermissionManager(testProfile());
    const importer = new FolderImportManager(admin, perms);
    await expect(importer.run({ plan, mode: 'insert', batchSize: 500 })).rejects.toThrow(ReadOnlyError);
    perms.enableWrites();
    const res = await importer.run({ plan, mode: 'insert', batchSize: 500 });
    expect(res.aborted).toBe(false);
    expect(res.documents).toBe(2502);
    expect((await admin.db(folderDb).listCollections().toArray()).map((c) => c.name).sort()).toEqual([
      'log',
      'orders',
      'users',
      'validated',
    ]);
    const [types] = await admin
      .db(folderDb)
      .collection('users')
      .aggregate([{ $limit: 1 }, { $project: { _id: 0, big: { $type: '$big' } } }])
      .toArray();
    expect(types).toEqual({ big: 'long' });
  });

  it('plans "all databases" folders and blocks the whole import when one file is invalid', async () => {
    const root = tmpDir();
    await fs.mkdir(path.join(root, 'db_a'));
    await fs.mkdir(path.join(root, 'admin'));
    await fs.writeFile(path.join(root, 'db_a', 'good.jsonl'), '{"a":1}\n');
    await fs.writeFile(path.join(root, 'db_a', 'bad.jsonl'), '{"a":1}\nnot json\n');
    await fs.writeFile(path.join(root, 'db_a', 'good.metadata.json'), '{}');
    const plan = await planFolderImport({ dir: root, allDatabases: true });
    expect(plan.map((p) => `${p.database}.${p.collection}`).sort()).toEqual(['db_a.bad', 'db_a.good']);
    const perms = new PermissionManager(testProfile());
    perms.enableWrites();
    const res = await new FolderImportManager(admin, perms).run({
      plan: plan.map((p) => ({ ...p, database: folderDb })),
      mode: 'insert',
      batchSize: 10,
    });
    expect(res.aborted).toBe(true);
    expect(res.invalid).toBe(1);
    expect(await admin.db(folderDb).collection('good').countDocuments()).toBe(0);
    await fs.writeFile(path.join(root, 'db_a', 'good.csv'), 'a\n1\n');
    await expect(planFolderImport({ dir: root, allDatabases: true })).rejects.toThrow(/cannot be imported/);
    expect(collectionNameFromFile('/x/users.jsonl.gz')).toBe('users');
    await expect(planFolderImport({ dir: root })).rejects.toThrow(/target database/);
  });
});
