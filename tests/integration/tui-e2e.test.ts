import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stripCredentials } from '../../src/connection/manual-connection.js';
import { findExecutable } from '../../src/utils/platform.js';
import { KEYS, PtySession } from '../helpers/pty-harness.js';
import { fileTmpDir, tmpDir } from '../helpers/tmp.js';
import {
  adminClient,
  dropTestDatabases,
  integrationEnabled,
  TEST_PASSWORD,
  TEST_URI,
  uniqueDbName,
} from './env.js';

/**
 * End-to-end tests of the real full-screen TUI inside a pseudo-terminal (POSIX `script`), with a
 * headless xterm emulator reconstructing the screen exactly as a user would see it.
 */
const BIN = path.resolve('dist/cli/bin.js');
const ptyAvailable = process.platform !== 'win32' && Boolean(findExecutable('script')) && existsSync(BIN);

describe.skipIf(!ptyAvailable)('TUI (offline) in a pseudo-terminal', () => {
  const env = () => ({ MTP_CONFIG_DIR: tmpDir(), MTP_DATA_DIR: tmpDir(), MTP_DISABLE_KEYRING: '1' });

  it('opens on the connections home, navigates and quits cleanly with Ctrl+C', async () => {
    const s = new PtySession([], { env: env(), cols: 100, rows: 30 });
    try {
      let screen = await s.waitFor('Welcome');
      expect(screen).toContain('MONGO TERMINAL PRO');
      expect(screen).toContain('Made by Vairag Kakadiya');
      expect(screen).toContain('Import from MongoDB Compass');
      await s.press('m', 800);
      screen = await s.waitFor('Main menu');
      expect(screen).toContain('connect first');
      await s.press('12', 900);
      await s.waitFor('Settings');
      await s.press(KEYS.esc, 300);
      await s.waitFor('Main menu');
      await s.press(KEYS.esc, 300);
      await s.waitFor('Welcome');
      await s.press('?', 300);
      await s.waitFor('Keyboard shortcuts');
      s.write(KEYS.ctrlC);
      expect(await s.exit()).toBe(0);
    } finally {
      s.kill();
    }
  });

  it('adapts to small terminals and ASCII / no-colour mode', async () => {
    const s = new PtySession(['--ascii', '--no-color'], { env: env(), cols: 60, rows: 16 });
    try {
      const screen = await s.waitFor('Welcome');
      expect(screen).toMatch(/\+-{10,}/);
      expect(screen).not.toMatch(/[╭│❯●]/);
      // eslint-disable-next-line no-control-regex
      expect(/\u001B\[38;2|\u001B\[3[0-7]m/.test(s.output)).toBe(false);
      for (const line of screen.split('\n')) expect([...line].length).toBeLessThanOrEqual(60);
      s.write(KEYS.ctrlC);
      await s.exit();
    } finally {
      s.kill();
    }
  });

  it('shows a message when the terminal is too small', async () => {
    const s = new PtySession([], { env: env(), cols: 30, rows: 8 });
    try {
      await s.waitFor('too small');
      s.write(KEYS.ctrlC);
      expect(await s.exit()).toBe(0);
    } finally {
      s.kill();
    }
  });
});

describe.skipIf(!ptyAvailable || !integrationEnabled())('TUI against MongoDB in a pseudo-terminal', () => {
  const db = uniqueDbName('tui');
  let admin: MongoClient;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    admin = await adminClient();
    await admin
      .db(db)
      .collection('things')
      .insertMany(Array.from({ length: 45 }, (_, i) => ({ label: `thing-${i}`, i })));
    env = {
      MTP_CONFIG_DIR: fileTmpDir(),
      MTP_DATA_DIR: fileTmpDir(),
      MTP_DISABLE_KEYRING: '1',
      NO_COLOR: '1',
    };
    const n = stripCredentials(TEST_URI as string);
    const uri = n.username ? (TEST_URI as string).replace(/:[^:@/]+@/, '@') : (TEST_URI as string);
    execFileSync(
      process.execPath,
      [BIN, 'connections', 'add', '--name', 'E2E', '--uri', uri, '--save-password', '--no-test'],
      { env: { ...process.env, ...env, MTP_PASSWORD: TEST_PASSWORD } },
    );
  });

  afterAll(async () => {
    await dropTestDatabases(admin, [db]);
    await admin?.close();
  });

  it('connects, browses documents with pagination and enforces read-only mode', async () => {
    const s = new PtySession(['-c', 'E2E'], { env, cols: 120, rows: 34 });
    try {
      // Connecting opens the workspace: database tree on the left.
      await s.waitFor('database(s)', 20_000);
      await s.waitFor('READ-ONLY');
      await s.press('/');
      await s.type(db);
      await s.press(KEYS.enter, 300);
      await s.press(KEYS.right, 1500); // expand the database
      await s.waitFor('things');
      await s.press(KEYS.down, 300);
      await s.press(KEYS.enter, 1500); // open the collection → Documents tab
      let screen = await s.waitFor('page 1/3');
      expect(screen).toContain('Docs');
      expect(screen).toContain(`${db} › things`);
      expect(screen).toContain('thing-0');
      await s.press(KEYS.right, 1000);
      screen = await s.waitFor('page 2/3');
      expect(screen).toContain('thing-20');
      await s.press('d', 800);
      screen = await s.waitFor('Read-only session');
      expect(await admin.db(db).collection('things').countDocuments()).toBe(45);
      await s.press('W', 600);
      await s.waitFor('Enable write access');
      await s.press('y', 800);
      await s.waitFor('WRITE ENABLED');
      await s.press('d', 800);
      await s.waitFor('Delete document');
      await s.press('y', 1500);
      await s.waitFor('Document deleted');
      expect(await admin.db(db).collection('things').countDocuments()).toBe(44);
      s.write(KEYS.ctrlC);
      expect(await s.exit()).toBe(0);
    } finally {
      s.kill();
    }
  });
});
