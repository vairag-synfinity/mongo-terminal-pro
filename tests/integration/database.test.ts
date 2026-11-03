import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Application } from '../../src/core/application.js';
import { ReadOnlyError } from '../../src/core/error-handler.js';
import { parseQuery } from '../../src/database/query-manager.js';
import { validatePipeline } from '../../src/database/aggregation-manager.js';
import { ObjectId } from '../../src/utils/bson.js';
import { KeysetAnchors } from '../../src/utils/pagination.js';
import { fileTmpPaths } from '../helpers/tmp.js';
import {
  adminClient,
  dropTestDatabases,
  integrationEnabled,
  TEST_PASSWORD,
  testProfile,
  uniqueDbName,
} from './env.js';

const enabled = integrationEnabled();

describe.skipIf(!enabled)(
  'MongoDB integration: connection, discovery, documents, queries, aggregation, indexes',
  () => {
    const db = uniqueDbName('db');
    let admin: MongoClient;
    let app: Application;

    beforeAll(async () => {
      admin = await adminClient();
      const docs = Array.from({ length: 95 }, (_, i) => ({
        _id: new ObjectId(),
        n: i,
        group: i % 5,
        name: `doc-${i}`,
        nested: { even: i % 2 === 0 },
      }));
      await admin.db(db).collection('items').insertMany(docs);
      await admin.db(db).createCollection('capped', { capped: true, size: 4096 });
      await admin
        .db(db)
        .createCollection('evenItems', { viewOn: 'items', pipeline: [{ $match: { 'nested.even': true } }] });
      process.env.MTP_DISABLE_KEYRING = '1';
      app = await Application.create({ paths: fileTmpPaths(), logging: false });
      await app.connect(testProfile(), TEST_PASSWORD);
    });

    afterAll(async () => {
      await app?.shutdown();
      await dropTestDatabases(admin, [db]);
      await admin?.close();
    });

    it('tests connections without changing the active one and reports server info', async () => {
      const result = await app.connectionManager.test(testProfile(), TEST_PASSWORD);
      expect(result.ok).toBe(true);
      expect(result.server?.version).toMatch(/^\d+\.\d+/);
      expect(['standalone', 'replica-set', 'sharded']).toContain(result.server?.topology);
      expect(app.connectionManager.isConnected).toBe(true);
      expect(await app.connectionManager.ping()).toBeGreaterThanOrEqual(0);
    });

    it('reports unreachable servers as friendly connection errors', async () => {
      const bad = await app.connectionManager.test(
        { ...testProfile({ uri: 'mongodb://127.0.0.1:1/', connectTimeoutMs: 800 }) },
        undefined,
      );
      expect(bad.ok).toBe(false);
      const { toFriendlyError } = await import('../../src/core/error-handler.js');
      expect(['CONNECTION']).toContain(toFriendlyError(bad.error).code);
    });

    it('discovers databases with stats, and collections with metadata (views separated)', async () => {
      const dbs = await app.db().databases.listWithStats();
      const mine = dbs.databases.find((d) => d.name === db);
      expect(mine?.stats?.collections).toBeGreaterThanOrEqual(2);
      const colls = await app.db().collections.list(db, { withStats: true });
      const items = colls.find((c) => c.name === 'items');
      expect(items?.type).toBe('collection');
      expect(items?.count).toBe(95);
      expect(items?.countIsEstimate).toBe(true);
      expect(items?.indexCount).toBe(1);
      expect(colls.find((c) => c.name === 'evenItems')?.type).toBe('view');
      expect(colls.find((c) => c.name === 'evenItems')?.count).toBeUndefined();
      expect(colls.find((c) => c.name === 'capped')?.capped).toBe(true);
      expect(await app.db().collections.exactCount(db, 'items', { group: 1 })).toBe(19);
      expect(await app.db().collections.estimatedCount(db, 'items')).toBe(95);
    });

    it('enforces read-only mode inside services', async () => {
      app.disableWrites();
      await expect(app.db().documents.insertOne(db, 'items', { x: 1 })).rejects.toThrow(ReadOnlyError);
      await expect(app.db().collections.drop(db, 'items')).rejects.toThrow(ReadOnlyError);
      await expect(app.db().indexes.create(db, 'items', { keys: { n: 1 } })).rejects.toThrow(ReadOnlyError);
      const q = parseQuery(
        { database: db, collection: 'items', operation: 'deleteMany', filter: '{}' },
        { resultLimit: 10, timeoutMs: 5000 },
      );
      await expect(app.db().queries.execute(q, { resultLimit: 10, timeoutMs: 5000 })).rejects.toThrow(
        ReadOnlyError,
      );
      expect(await app.db().collections.estimatedCount(db, 'items')).toBe(95);
    });

    it('paginates with keyset anchors without gaps or duplicates', async () => {
      const anchors = new KeysetAnchors<unknown>();
      const seen: number[] = [];
      let page = 0;
      for (;;) {
        const res = await app.db().documents.findPage({
          database: db,
          collection: 'items',
          page,
          pageSize: 20,
          anchors,
          maxTimeMS: 5000,
        });
        if (page > 0) expect(res.pageInfo.strategy).toBe('keyset');
        seen.push(...res.documents.map((d) => Number(d.n)));
        if (!res.pageInfo.hasNext) break;
        page++;
      }
      expect(seen).toEqual(Array.from({ length: 95 }, (_, i) => i));
      // Going back uses stored anchors.
      const back = await app.db().documents.findPage({
        database: db,
        collection: 'items',
        page: 1,
        pageSize: 20,
        anchors,
        maxTimeMS: 5000,
      });
      expect(Number(back.documents[0]?.n)).toBe(20);
    });

    it('falls back to offset pagination for custom sorts and filters', async () => {
      const res = await app.db().documents.findPage({
        database: db,
        collection: 'items',
        filter: { group: 2 },
        sort: { n: -1 },
        page: 1,
        pageSize: 5,
        anchors: new KeysetAnchors(),
        maxTimeMS: 5000,
      });
      expect(res.pageInfo.strategy).toBe('offset');
      expect(res.documents.map((d) => Number(d.n))).toEqual([67, 62, 57, 52, 47]);
      const filtered = await app.db().documents.findPage({
        database: db,
        collection: 'items',
        filter: { group: 3 },
        page: 0,
        pageSize: 50,
        anchors: new KeysetAnchors(),
        maxTimeMS: 5000,
      });
      expect(filtered.documents).toHaveLength(19);
      expect(filtered.pageInfo.hasNext).toBe(false);
    });

    it('performs document CRUD with validation once writes are enabled', async () => {
      app.enableWrites();
      const id = await app.db().documents.insertOne(db, 'items', { name: 'new', n: 1000 });
      const doc = await app.db().documents.findById(db, 'items', id);
      expect(doc?.name).toBe('new');
      const res = await app
        .db()
        .documents.replaceById(db, 'items', id, { _id: id, name: 'changed', n: 1000 });
      expect(res).toEqual({ matched: 1, modified: 1 });
      await expect(
        app.db().documents.replaceById(db, 'items', id, { _id: new ObjectId(), name: 'x' }),
      ).rejects.toThrow(/_id field cannot be changed/);
      await expect(app.db().documents.insertOne(db, 'items', { $bad: 1 })).rejects.toThrow(/not valid/);
      const copyId = await app
        .db()
        .documents.duplicate(db, 'items', (await app.db().documents.findById(db, 'items', id)) as never);
      expect(String(copyId)).not.toBe(String(id));
      expect(await app.db().documents.deleteById(db, 'items', id)).toBe(1);
      expect(await app.db().documents.deleteById(db, 'items', copyId)).toBe(1);
      app.disableWrites();
    });

    it('edits whole documents without changing numeric BSON types', async () => {
      const { Double, Int32, Long } = await import('../../src/utils/bson.js');
      const { toShellString } = await import('../../src/ui/components/bson-format.js');
      const { parseMongoObject } = await import('../../src/utils/validation.js');
      const { insertedId } = await admin
        .db(db)
        .collection('typed')
        .insertOne({ i: new Int32(1), l: Long.fromNumber(2), d: new Double(3), label: 'before' });
      const loaded = await app.db().documents.findById(db, 'typed', insertedId);
      const edited = parseMongoObject(toShellString(loaded).replace('"before"', '"after"'));
      app.enableWrites();
      await app.db().documents.replaceById(db, 'typed', insertedId, edited);
      app.disableWrites();
      const [types] = await admin
        .db(db)
        .collection('typed')
        .aggregate([
          { $project: { _id: 0, i: { $type: '$i' }, l: { $type: '$l' }, d: { $type: '$d' }, label: 1 } },
        ])
        .toArray();
      expect(types).toEqual({ i: 'int', l: 'long', d: 'double', label: 'after' });
    });

    it('executes queries with limits, truncation, count and distinct', async () => {
      const limits = { resultLimit: 10, timeoutMs: 5000 };
      const find = await app.db().queries.execute(
        parseQuery(
          {
            database: db,
            collection: 'items',
            operation: 'find',
            filter: '{ group: 0 }',
            sort: '{ n: 1 }',
            projection: '{ n: 1, _id: 0 }',
            limit: 0,
          },
          limits,
        ),
        limits,
      );
      expect(find.documents).toHaveLength(10);
      expect(find.truncated).toBe(true);
      expect(find.documents?.[0]).toEqual({ n: 0 });
      const one = await app
        .db()
        .queries.execute(
          parseQuery({ database: db, collection: 'items', operation: 'findOne', filter: '{ n: 7 }' }, limits),
          limits,
        );
      expect(one.documents?.[0]?.name).toBe('doc-7');
      const count = await app
        .db()
        .queries.execute(
          parseQuery(
            { database: db, collection: 'items', operation: 'count', filter: '{ "nested.even": true }' },
            limits,
          ),
          limits,
        );
      expect(count.count).toBe(48);
      const distinct = await app.db().queries.execute(
        parseQuery(
          {
            database: db,
            collection: 'items',
            operation: 'distinct',
            filter: '{}',
            distinctField: 'group',
            limit: 3,
          },
          limits,
        ),
        limits,
      );
      expect(distinct.count).toBe(5);
      expect(distinct.values).toHaveLength(3);
      expect(distinct.truncated).toBe(true);
    });

    it('previews and executes destructive queries only with write access', async () => {
      const limits = { resultLimit: 10, timeoutMs: 5000 };
      app.enableWrites();
      await admin
        .db(db)
        .collection('scratch')
        .insertMany([{ s: 1 }, { s: 1 }, { s: 2 }]);
      const upd = parseQuery(
        {
          database: db,
          collection: 'scratch',
          operation: 'updateMany',
          filter: '{ s: 1 }',
          update: '{ $set: { t: true } }',
        },
        limits,
      );
      expect(await app.db().queries.previewAffected(upd, 5000)).toBe(2);
      expect((await app.db().queries.execute(upd, limits)).modified).toBe(2);
      const del = parseQuery(
        { database: db, collection: 'scratch', operation: 'deleteOne', filter: '{ s: 2 }' },
        limits,
      );
      expect((await app.db().queries.execute(del, limits)).deleted).toBe(1);
      app.disableWrites();
    });

    it('runs aggregation pipelines with result caps and guards $out', async () => {
      const v = validatePipeline([
        { operator: '$match', body: '{}' },
        { operator: '$group', body: '{ _id: "$group", c: { $sum: 1 } }' },
        { operator: '$sort', body: '{ _id: 1 }' },
      ]);
      const res = await app
        .db()
        .aggregations.run(db, 'items', v.pipeline, { resultLimit: 3, timeoutMs: 5000, allowDiskUse: false });
      expect(res.returned).toBe(3);
      expect(res.truncated).toBe(true);
      expect(res.documents[0]).toEqual({ _id: 0, c: 19 });
      const out = validatePipeline([
        { operator: '$match', body: '{ group: 1 }' },
        { operator: '$out', body: '"groupOne"' },
      ]);
      await expect(
        app.db().aggregations.run(db, 'items', out.pipeline, {
          resultLimit: 3,
          timeoutMs: 5000,
          allowDiskUse: false,
        }),
      ).rejects.toThrow(ReadOnlyError);
      app.enableWrites();
      const wrote = await app.db().aggregations.run(db, 'items', out.pipeline, {
        resultLimit: 3,
        timeoutMs: 5000,
        allowDiskUse: false,
      });
      expect(wrote.wroteData).toBe(true);
      expect(await admin.db(db).collection('groupOne').countDocuments()).toBe(19);
      app.disableWrites();
    });

    it('manages indexes and reports usage', async () => {
      app.enableWrites();
      const name = await app
        .db()
        .indexes.create(db, 'items', { keys: { name: 1 }, unique: true, name: 'name_unique' });
      await expect(
        app
          .db()
          .indexes.create(db, 'items', { keys: { createdAt: 1 }, expireAfterSeconds: 3600 * 24 * 365 * 100 }),
      ).rejects.toThrow(/between 0 and 2147483647/);
      await app
        .db()
        .indexes.create(db, 'items', { keys: { createdAt: 1 }, expireAfterSeconds: 3600 * 24 * 365 * 50 });
      await app
        .db()
        .indexes.create(db, 'items', { keys: { group: 1 }, partialFilterExpression: { n: { $gt: 10 } } });
      const list = await app.db().indexes.list(db, 'items');
      const byName = Object.fromEntries(list.map((i) => [i.name, i]));
      expect(byName.name_unique?.unique).toBe(true);
      expect(byName.createdAt_1?.type).toBe('ttl');
      expect(byName.group_1?.partialFilterExpression).toEqual({ n: { $gt: 10 } });
      const usage = await app.db().indexes.usage(db, 'items');
      expect(usage.supported).toBe(true);
      await expect(app.db().indexes.drop(db, 'items', '_id_')).rejects.toThrow(/cannot be dropped/);
      await app.db().indexes.drop(db, 'items', name);
      expect((await app.db().indexes.list(db, 'items')).some((i) => i.name === name)).toBe(false);
      app.disableWrites();
    });

    it('creates and drops collections when allowed', async () => {
      app.enableWrites();
      await app.db().collections.create(db, 'temp_coll');
      expect(await app.db().collections.exists(db, 'temp_coll')).toBe(true);
      await app.db().collections.drop(db, 'temp_coll');
      expect(await app.db().collections.exists(db, 'temp_coll')).toBe(false);
      await expect(app.db().databases.drop('admin')).rejects.toThrow(/system database/);
      app.disableWrites();
    });

    it('analyses schema from a bounded $sample', async () => {
      const schema = await app.db().schema.analyze(db, 'items', 50, 5000);
      expect(schema.sampleSize).toBe(50);
      expect(schema.method).toBe('$sample');
      expect(schema.fields.map((f) => f.path)).toEqual(
        expect.arrayContaining(['_id', 'n', 'group', 'name', 'nested', 'nested.even']),
      );
      const view = await app.db().schema.analyze(db, 'evenItems', 10, 5000);
      expect(view.sampleSize).toBeGreaterThan(0);
    });

    it('collects monitoring snapshots and computes rates', async () => {
      const first = await app.monitoring().snapshot();
      expect(first.connected).toBe(true);
      expect(first.pool.maxPoolSize).toBe(10);
      await admin.db(db).collection('items').findOne({});
      const second = await app.monitoring().snapshot({ includeDatabases: true });
      if (second.serverStatus.available) expect(second.opsPerSecond).toBeDefined();
      expect(second.databases?.databases.some((d) => d.name === db)).toBe(true);
      if (second.server?.topology === 'replica-set') expect(second.replicaSet.available).toBe(true);
    });
  },
);
