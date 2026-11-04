import { execFile } from 'node:child_process';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileTmpDir, tmpDir } from '../helpers/tmp.js';
import {
  adminClient,
  dropTestDatabases,
  integrationEnabled,
  TEST_PASSWORD,
  TEST_URI,
  uniqueDbName,
} from './env.js';
import { stripCredentials } from '../../src/connection/manual-connection.js';

const exec = promisify(execFile);
const BIN = path.resolve('dist/cli/bin.js');
const built = existsSync(BIN);

/** Runs the built CLI with an isolated configuration directory. */
async function cli(
  args: string[],
  env: NodeJS.ProcessEnv,
  allowFail = false,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env, NO_COLOR: '1', MTP_DISABLE_KEYRING: '1' },
      timeout: 60_000,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const e = error as { stdout: string; stderr: string; code: number };
    if (!allowFail)
      throw new Error(`CLI failed (${args.join(' ')}): ${e.stderr || e.stdout}`, { cause: error });
    return { stdout: e.stdout, stderr: e.stderr, code: e.code };
  }
}

describe.skipIf(!built)('CLI (offline)', () => {
  it('prints help and version', async () => {
    const help = await cli(['--help'], {});
    expect(help.stdout).toMatch(/Usage: mongo-terminal/);
    expect(help.stdout).toMatch(/connections/);
    const version = await cli(['--version'], {});
    expect(version.stdout.trim()).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  });

  it('refuses passwords in command-line arguments', async () => {
    const r = await cli(
      ['connections', 'add', '--name', 'x', '--uri', 'mongodb://u:secret@localhost'],
      { MTP_CONFIG_DIR: tmpDir() },
      true,
    );
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/Do not include the password/);
  });

  it('reports a helpful error without a TTY for the dashboard', async () => {
    const r = await cli([], { MTP_CONFIG_DIR: tmpDir() }, true);
    expect(r.stderr).toMatch(/needs an interactive terminal/);
  });

  it('runs doctor, tools and config commands', async () => {
    const env = { MTP_CONFIG_DIR: tmpDir(), MTP_DATA_DIR: tmpDir() };
    expect((await cli(['doctor'], env)).stdout).toMatch(/Credential storage/);
    expect((await cli(['tools'], env)).stdout).toMatch(/mongodump/);
    const paths = JSON.parse((await cli(['config', 'path'], env)).stdout);
    expect(paths.configDir).toBe(env.MTP_CONFIG_DIR);
  });
});

describe.skipIf(!built || !integrationEnabled())('CLI against MongoDB', () => {
  const db = uniqueDbName('cli');
  let admin: MongoClient;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    admin = await adminClient();
    await admin
      .db(db)
      .collection('people')
      .insertMany(Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, age: i })));
    env = { MTP_CONFIG_DIR: fileTmpDir(), MTP_DATA_DIR: fileTmpDir(), MTP_PASSWORD: TEST_PASSWORD };
    const n = stripCredentials(TEST_URI as string);
    const uri = n.username ? (TEST_URI as string).replace(/:[^:@/]+@/, '@') : (TEST_URI as string);
    await cli(['connections', 'add', '--name', 'IT', '--uri', uri, '--save-password', '--no-test'], env);
  });

  afterAll(async () => {
    await dropTestDatabases(admin, [db]);
    await admin?.close();
  });

  it('lists connections (masked), databases and collections', async () => {
    const list = JSON.parse((await cli(['connections', 'list', '--json'], env)).stdout) as {
      name: string;
      uri: string;
      isDefault: boolean;
    }[];
    expect(list[0]?.name).toBe('IT');
    expect(list[0]?.isDefault).toBe(true);
    if (TEST_PASSWORD) expect(JSON.stringify(list)).not.toContain(TEST_PASSWORD);
    const dbs = JSON.parse((await cli(['databases', '--json'], env)).stdout) as {
      databases: { name: string }[];
    };
    expect(dbs.databases.map((d) => d.name)).toContain(db);
    const colls = JSON.parse((await cli(['collections', '--db', db, '--json'], env)).stdout) as {
      name: string;
      count: number;
    }[];
    expect(colls.find((c) => c.name === 'people')?.count).toBe(40);
    expect((await cli(['status'], env)).stdout).toMatch(/Connected/);
  });

  it('queries, exports and imports (import requires --write)', async () => {
    const q = await cli(
      [
        'query',
        '--db',
        db,
        '--collection',
        'people',
        '--filter',
        '{ age: { $gte: 38 } }',
        '--sort',
        '{ age: 1 }',
      ],
      env,
    );
    expect(q.stdout).toContain('"p38"');
    expect(q.stdout).toContain('"p39"');
    const out = path.join(tmpDir(), 'people.json');
    await cli(['export', '--db', db, '--collection', 'people', '--format', 'json', '--out', out], env);
    expect(JSON.parse(await fs.readFile(out, 'utf8'))).toHaveLength(40);

    const denied = await cli(['import', '--db', db, '--collection', 'copy', '--file', out], env, true);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/read-only by default/);
    const dry = await cli(['import', '--db', db, '--collection', 'copy', '--file', out, '--dry-run'], env);
    expect(dry.stdout).toMatch(/nothing was written/);
    await cli(['import', '--db', db, '--collection', 'copy', '--file', out, '--write', '--yes'], env);
    expect(await admin.db(db).collection('copy').countDocuments()).toBe(40);
  });

  it('copies databases, exports all databases and imports folders', async () => {
    const copyDb = `${db}_copy`.slice(0, 60);
    const denied = await cli(['copy', '--from-db', db, '--to-db', copyDb], env, true);
    expect(denied.stderr).toMatch(/--write/);
    await cli(
      ['copy', '--from-db', db, '--to-db', copyDb, '--collections', 'people', '--write', '--yes'],
      env,
    );
    expect(await admin.db(copyDb).collection('people').countDocuments()).toBe(40);
    const again = await cli(
      ['copy', '--from-db', db, '--to-db', copyDb, '--collections', 'people', '--write', '--yes'],
      env,
      true,
    );
    expect(again.code).toBe(2);
    expect(again.stdout + again.stderr).toMatch(/duplicate _id/);
    const out = path.join(tmpDir(), 'all');
    await cli(['export', '--all-databases', '--out', out], env);
    expect((await fs.readdir(path.join(out, db))).sort()).toContain('people.json');
    const folderDb = `${db}_dir`.slice(0, 60);
    await cli(['import', '--dir', path.join(out, db), '--db', folderDb, '--write', '--yes'], env);
    expect(await admin.db(folderDb).collection('people').countDocuments()).toBe(40);
    await dropTestDatabases(admin, [copyDb, folderDb]);
  });

  it('protects production connections in non-interactive mode', async () => {
    const prodEnv = { ...env, MTP_CONFIG_DIR: tmpDir() };
    const n = stripCredentials(TEST_URI as string);
    const uri = n.username ? (TEST_URI as string).replace(/:[^:@/]+@/, '@') : (TEST_URI as string);
    await cli(
      ['connections', 'add', '--name', 'Prod', '--uri', uri, '--production', '--save-password', '--no-test'],
      prodEnv,
    );
    const file = path.join(tmpDir(), 'one.json');
    await fs.writeFile(file, '[{"a":1}]');
    const blocked = await cli(
      ['import', '--db', db, '--collection', 'prod_copy', '--file', file, '--write', '--yes'],
      prodEnv,
      true,
    );
    expect(blocked.code).not.toBe(0);
    expect(blocked.stderr).toMatch(/production connection/i);
    const wrong = await cli(
      ['import', '--db', db, '--collection', 'prod_copy', '--file', file, '--write', '--confirm', 'prod'],
      prodEnv,
      true,
    );
    expect(wrong.code).not.toBe(0);
    await cli(
      ['import', '--db', db, '--collection', 'prod_copy', '--file', file, '--write', '--confirm', 'Prod'],
      prodEnv,
    );
    expect(await admin.db(db).collection('prod_copy').countDocuments()).toBe(1);
  });
});
