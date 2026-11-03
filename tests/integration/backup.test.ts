import { promises as fs } from 'node:fs';
import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackupManager } from '../../src/backup/backup-manager.js';
import { locateTool } from '../../src/backup/database-tools.js';
import { checkCollisions, inspectBackup, RestoreManager } from '../../src/backup/restore-manager.js';
import { Application } from '../../src/core/application.js';
import { fileTmpPaths, tmpDir } from '../helpers/tmp.js';
import {
  adminClient,
  dropTestDatabases,
  integrationEnabled,
  TEST_PASSWORD,
  testProfile,
  uniqueDbName,
} from './env.js';

const enabled = integrationEnabled() && Boolean(locateTool('mongodump') && locateTool('mongorestore'));

describe.skipIf(!enabled)('MongoDB Database Tools integration: backup and restore', () => {
  const source = uniqueDbName('bk');
  const target = uniqueDbName('rs');
  let admin: MongoClient;
  let app: Application;
  const profile = testProfile();

  beforeAll(async () => {
    admin = await adminClient();
    await admin
      .db(source)
      .collection('a')
      .insertMany(Array.from({ length: 300 }, (_, i) => ({ i })));
    await admin
      .db(source)
      .collection('b')
      .insertMany([{ x: 1 }, { x: 2 }]);
    await admin.db(source).collection('a').createIndex({ i: 1 });
    process.env.MTP_DISABLE_KEYRING = '1';
    app = await Application.create({ paths: fileTmpPaths(), logging: false });
    await app.connect(profile, TEST_PASSWORD);
  });

  afterAll(async () => {
    await app?.shutdown();
    await dropTestDatabases(admin, [source, target]);
    await admin?.close();
  });

  it('creates verified directory and archive backups and records history', async () => {
    const out = tmpDir();
    const manager = new BackupManager(app.backupHistory);
    const lines: string[] = [];
    const dirResult = await manager.run(profile, TEST_PASSWORD, {
      database: source,
      gzip: true,
      archive: false,
      outputDir: out,
      onOutput: (l) => lines.push(l),
    });
    expect(dirResult.success).toBe(true);
    expect(dirResult.verification?.totalDocuments).toBe(302);
    expect(dirResult.verification?.namespaces.map((n) => n.namespace).sort()).toEqual([
      `${source}.a`,
      `${source}.b`,
    ]);
    expect(lines.join('\n')).toMatch(/done dumping/);
    expect(lines.join('\n')).not.toMatch(/password/i);

    const archive = await manager.run(profile, TEST_PASSWORD, {
      database: source,
      collection: 'a',
      gzip: true,
      archive: true,
      outputDir: out,
    });
    expect(archive.success).toBe(true);
    expect(archive.path).toMatch(/\.archive\.gz$/);
    expect((await fs.stat(archive.path)).size).toBeGreaterThan(0);

    const history = await app.backupHistory.list();
    expect(history.slice(0, 2).every((r) => r.status === 'success' && r.verified)).toBe(true);
  });

  it('restores into another database, reports collisions and never drops without asking', async () => {
    const out = tmpDir();
    const backup = await new BackupManager(app.backupHistory).run(profile, TEST_PASSWORD, {
      database: source,
      gzip: false,
      archive: false,
      outputDir: out,
    });
    const restore = new RestoreManager(app.backupHistory, app.permissions);
    await expect(
      restore.run(profile, TEST_PASSWORD, {
        path: backup.path,
        drop: false,
        fromDatabase: source,
        toDatabase: target,
      }),
    ).rejects.toThrow(/requires write access/);

    const dry = await restore.run(profile, TEST_PASSWORD, {
      path: backup.path,
      drop: false,
      fromDatabase: source,
      toDatabase: target,
      dryRun: true,
    });
    expect(dry.success).toBe(true);
    expect(await admin.db(target).collection('a').countDocuments()).toBe(0);

    app.enableWrites();
    const first = await restore.run(profile, TEST_PASSWORD, {
      path: backup.path,
      drop: false,
      fromDatabase: source,
      toDatabase: target,
    });
    expect(first.success).toBe(true);
    expect(first.restoredDocuments).toBe(302);
    expect(await admin.db(target).collection('a').countDocuments()).toBe(300);
    expect((await admin.db(target).collection('a').indexes()).some((i) => i.name === 'i_1')).toBe(true);

    const inspection = await inspectBackup(backup.path);
    const collisions = await checkCollisions(admin, inspection, { fromDatabase: source, toDatabase: target });
    expect(collisions.every((c) => c.exists)).toBe(true);

    const again = await restore.run(profile, TEST_PASSWORD, {
      path: backup.path,
      drop: false,
      fromDatabase: source,
      toDatabase: target,
    });
    expect(again.success).toBe(false); // duplicate _id values fail; existing data is kept
    expect(await admin.db(target).collection('a').countDocuments()).toBe(300);

    await admin.db(target).collection('a').insertOne({ extra: true });
    const dropped = await restore.run(profile, TEST_PASSWORD, {
      path: backup.path,
      drop: true,
      fromDatabase: source,
      toDatabase: target,
    });
    expect(dropped.success).toBe(true);
    expect(await admin.db(target).collection('a').countDocuments()).toBe(300);
    app.disableWrites();
  });

  it('detects tampered backups', async () => {
    const out = tmpDir();
    const backup = await new BackupManager(app.backupHistory).run(profile, TEST_PASSWORD, {
      database: source,
      collection: 'b',
      gzip: false,
      archive: false,
      outputDir: out,
    });
    expect(backup.success).toBe(true);
    const { verifyDirectoryBackup, parseDumpCounts } = await import('../../src/backup/backup-validator.js');
    const bsonFile = `${backup.path}/${source}/b.bson`;
    const data = await fs.readFile(bsonFile);
    await fs.writeFile(bsonFile, data.subarray(0, data.length - 3));
    const verification = await verifyDirectoryBackup(
      backup.path,
      parseDumpCounts(`done dumping ${source}.b (2 documents)`),
    );
    expect(verification.ok).toBe(false);
  });
});
