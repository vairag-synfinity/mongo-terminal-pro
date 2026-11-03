import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationManager,
  createConfigBackup,
  HistoryManager,
  restoreConfigBackup,
} from '../../src/config/configuration.js';
import { DEFAULT_SETTINGS } from '../../src/config/defaults.js';
import { writeFileAtomic } from '../../src/config/json-store.js';
import { ConnectionStorage } from '../../src/connection/connection-storage.js';
import { CredentialManager } from '../../src/security/credential-manager.js';
import {
  displayWidth,
  formatBytes,
  formatCount,
  formatDuration,
  formatNumber,
  padEnd,
  truncate,
} from '../../src/utils/formatting.js';
import {
  clampPageSize,
  describePage,
  KeysetAnchors,
  pageCount,
  visibleWindow,
} from '../../src/utils/pagination.js';
import { splitCommand } from '../../src/utils/external-editor.js';
import { osc52Sequence } from '../../src/utils/clipboard.js';
import { tmpDir, tmpPaths } from '../helpers/tmp.js';

describe('configuration', () => {
  it('provides validated defaults and persists changes', async () => {
    const paths = tmpPaths();
    const config = new ConfigurationManager(paths);
    expect(await config.get()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.pageSize).toBe(20);
    await config.set('pageSize', 50);
    const reread = new ConfigurationManager(paths);
    expect((await reread.get()).pageSize).toBe(50);
    await expect(config.set('pageSize', 0)).rejects.toThrow();
    await config.reset();
    expect((await config.get()).pageSize).toBe(20);
  });

  it('quarantines invalid settings files', async () => {
    const paths = tmpPaths();
    await fs.mkdir(paths.configDir, { recursive: true });
    await fs.writeFile(paths.settingsFile, JSON.stringify({ pageSize: 'lots' }));
    const config = new ConfigurationManager(paths);
    expect((await config.get()).pageSize).toBe(20);
    expect(config.store.lastRecoveryMessage).toMatch(/failed validation/);
  });

  it('writes files atomically', async () => {
    const file = path.join(tmpDir(), 'nested', 'x.json');
    await writeFileAtomic(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps bounded, de-duplicated query history and saved queries', async () => {
    const paths = tmpPaths();
    const history = new HistoryManager(paths, async () => 3);
    const base = {
      database: 'd',
      collection: 'c',
      operation: 'find' as const,
      projection: '',
      sort: '',
      update: '',
      distinctField: '',
      limit: 20,
      skip: 0,
    };
    for (const f of ['{a:1}', '{a:2}', '{a:1}', '{a:3}', '{a:4}'])
      await history.addHistory({ ...base, filter: f });
    expect((await history.listHistory()).map((q) => q.filter)).toEqual(['{a:4}', '{a:3}', '{a:1}']);
    await history.saveQuery({ ...base, filter: '{x:1}', name: 'mine' });
    await history.saveQuery({ ...base, filter: '{x:2}', name: 'mine' });
    expect((await history.listSavedQueries()).map((q) => q.filter)).toEqual(['{x:2}']);
    await history.clearHistory();
    expect(await history.listHistory()).toEqual([]);
  });

  it('backs up configuration without secrets and restores it (merge)', async () => {
    const paths = tmpPaths();
    process.env.MTP_DISABLE_KEYRING = '1';
    const storage = new ConnectionStorage(paths, new CredentialManager(paths, async () => 'encrypted-file'));
    await storage.create(
      { name: 'A', kind: 'local', uri: 'mongodb://user:Pa55word@localhost/' },
      { savePassword: true },
    );
    const out = path.join(tmpDir(), 'backup.json');
    await createConfigBackup(paths, out);
    const text = readFileSync(out, 'utf8');
    expect(text).not.toContain('Pa55word');
    expect(JSON.parse(text).connections.profiles[0].hasStoredPassword).toBe(false);

    const other = tmpPaths();
    const result = await restoreConfigBackup(other, out, { merge: true });
    expect(result.connections).toBe(1);
    const restored = new ConnectionStorage(other, new CredentialManager(other, async () => 'encrypted-file'));
    expect((await restored.list())[0]?.name).toBe('A');
    await expect(
      restoreConfigBackup(other, path.join(tmpDir(), 'missing.json'), { merge: true }),
    ).rejects.toThrow();
  });
});

describe('pagination', () => {
  it('clamps page sizes', () => {
    expect(clampPageSize(undefined)).toBe(20);
    expect(clampPageSize(0)).toBe(1);
    expect(clampPageSize(10_000)).toBe(500);
  });

  it('tracks keyset anchors and invalidates later pages', () => {
    const a = new KeysetAnchors<number>();
    expect(a.has(0)).toBe(true);
    expect(a.has(1)).toBe(false);
    a.record(0, 20);
    a.record(1, 40);
    expect(a.get(2)).toBe(40);
    a.record(0, 21);
    expect(a.get(1)).toBe(21);
    expect(a.has(2)).toBe(false);
    a.record(5, 99); // after an offset jump: earlier pages remain unknown
    expect(a.has(3)).toBe(false);
    expect(a.has(6)).toBe(true);
  });

  it('describes pages and visible windows', () => {
    expect(
      describePage({
        page: 1,
        pageSize: 20,
        itemCount: 20,
        hasNext: true,
        hasPrevious: true,
        total: 95,
        totalIsEstimate: true,
        strategy: 'keyset',
      }),
    ).toBe('21-40 of ~95 · page 2/5');
    expect(pageCount(0, 20)).toBe(1);
    expect(visibleWindow(100, 50, 10, 0)).toEqual({ start: 41, end: 51 });
    expect(visibleWindow(5, 2, 10)).toEqual({ start: 0, end: 5 });
    expect(visibleWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
  });
});

describe('formatting', () => {
  it('formats sizes, numbers, counts and durations', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatCount(1500, true)).toBe('~1,500');
    expect(formatCount(1500, false)).toBe('1,500');
    expect(formatDuration(250)).toBe('250 ms');
    expect(formatDuration(65_000)).toBe('1m 5s');
  });

  it('handles wide characters when truncating and padding', () => {
    expect(displayWidth('日本')).toBe(4);
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(truncate('日本語テキスト', 5)).toBe('日本…');
    expect(truncate('a\nb', 10)).toBe('a b');
    expect(padEnd('日', 4)).toBe('日  ');
  });
});

describe('misc utilities', () => {
  it('splits editor commands without a shell', () => {
    expect(splitCommand('code --wait')).toEqual(['code', '--wait']);
    expect(splitCommand('"C:\\Program Files\\Notepad++\\notepad++.exe" -multiInst')).toEqual([
      'C:\\Program Files\\Notepad++\\notepad++.exe',
      '-multiInst',
    ]);
  });

  it('builds OSC 52 clipboard sequences', () => {
    const seq = osc52Sequence('hi');
    expect(seq).toContain(Buffer.from('hi').toString('base64'));
    expect(seq.startsWith('\u001B]52;c;') || seq.startsWith('\u001BPtmux')).toBe(true);
  });
});
