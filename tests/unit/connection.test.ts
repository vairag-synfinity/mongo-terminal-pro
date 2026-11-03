import { promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  discoverCompassConnections,
  parseCompassConnection,
  parseCompassExportFile,
} from '../../src/connection/compass-discovery.js';
import { importDiscovered, markExisting } from '../../src/connection/connection-discovery.js';
import { buildClientOptions, needsPassword } from '../../src/connection/connection-manager.js';
import { ConnectionStorage } from '../../src/connection/connection-storage.js';
import { validateDraft, validateUri } from '../../src/connection/connection-validator.js';
import {
  candidatesToConnections,
  collectFromEnvironment,
  collectFromProjectDirectory,
  parseDotEnv,
} from '../../src/connection/env-discovery.js';
import {
  buildConnectionFromDraft,
  describeHosts,
  detectKind,
  stripCredentials,
} from '../../src/connection/manual-connection.js';
import { CredentialManager } from '../../src/security/credential-manager.js';
import { FIXTURES, tmpDir, tmpPaths } from '../helpers/tmp.js';

describe('manual connections', () => {
  it('strips credentials from URIs and keeps options', () => {
    const n = stripCredentials(
      'mongodb://alice:p%40ss@h1:27017,h2:27018/shop?replicaSet=rs0&authSource=admin',
    );
    expect(n.username).toBe('alice');
    expect(n.password).toBe('p@ss');
    expect(n.uri).not.toContain('alice');
    expect(n.uri).not.toContain('p%40ss');
    expect(n.uri).toContain('replicaSet=rs0');
    expect(n.hosts).toEqual(['h1:27017', 'h2:27018']);
    expect(n.defaultDatabase).toBe('shop');
    expect(n.authSource).toBe('admin');
  });

  it('builds URIs from form fields', () => {
    const n = buildConnectionFromDraft({
      name: 'x',
      kind: 'replica-set',
      host: 'a.example.com, b.example.com',
      port: 27019,
      replicaSet: 'rs1',
      authSource: 'admin',
      username: 'u',
      password: 'p',
    });
    expect(n.uri).toBe('mongodb://a.example.com:27019,b.example.com:27019/?replicaSet=rs1&authSource=admin');
    expect(n.password).toBe('p');
    const srv = buildConnectionFromDraft({
      name: 'x',
      kind: 'atlas',
      host: 'cluster0.abc.mongodb.net',
      srv: true,
      defaultDatabase: 'app',
    });
    expect(srv.uri).toBe('mongodb+srv://cluster0.abc.mongodb.net/app');
  });

  it('detects connection kinds', () => {
    expect(detectKind('mongodb+srv://cluster0.abc.mongodb.net/')).toBe('atlas');
    expect(detectKind('mongodb://localhost:27017')).toBe('local');
    expect(detectKind('mongodb://h1,h2/')).toBe('replica-set');
    expect(detectKind('mongodb://db.internal:27017/')).toBe('self-hosted');
    expect(describeHosts('mongodb+srv://c.mongodb.net/')).toBe('c.mongodb.net (SRV)');
  });

  it('validates URIs and drafts', () => {
    expect(validateUri('http://x')).toMatch(/must start/);
    expect(validateUri('mongodb+srv://a:27017')).toMatch(/port/);
    expect(validateUri('mongodb://localhost')).toBeUndefined();
    const v = validateDraft({ name: '', kind: 'local', host: 'bad host' });
    expect(v.valid).toBe(false);
    expect(v.errors.name).toBeDefined();
    expect(v.errors.host).toBeDefined();
    expect(
      validateDraft({ name: 'dup', kind: 'local', uri: 'mongodb://localhost' }, ['DUP']).errors.name,
    ).toMatch(/exists/);
    expect(
      validateDraft({ name: 'r', kind: 'self-hosted', uri: 'mongodb://db.example.com' }).warnings.join(' '),
    ).toMatch(/without TLS/);
    expect(
      validateDraft({ name: 'r', kind: 'local', uri: 'mongodb://u:p@localhost' }).warnings.join(' '),
    ).toMatch(/moved out of the URI/);
    expect(
      validateDraft({
        name: 'r',
        kind: 'local',
        uri: 'mongodb://localhost',
        tls: { allowInvalidCertificates: true },
      }).warnings.join(' '),
    ).toMatch(/disabled/);
  });

  it('passes credentials through driver auth options, never the URI', () => {
    const opts = buildClientOptions(
      {
        username: 'u',
        authSource: 'admin',
        tls: { mode: 'on', caFile: '/ca.pem', allowInvalidCertificates: false, allowInvalidHostnames: false },
      },
      'pw',
      { connectTimeoutMs: 1234, maxPoolSize: 7 },
    );
    expect(opts.auth).toEqual({ username: 'u', password: 'pw' });
    expect(opts.tls).toBe(true);
    expect(opts.tlsCAFile).toBe('/ca.pem');
    expect(opts.serverSelectionTimeoutMS).toBe(1234);
    expect(opts.maxPoolSize).toBe(7);
    expect(opts.appName).toBe('mongo-terminal-pro');
  });

  it('knows passwordless mechanisms', () => {
    expect(needsPassword({ authMechanism: 'MONGODB-X509' })).toBe(false);
    expect(needsPassword({ authMechanism: undefined })).toBe(true);
  });
});

describe('connection storage', () => {
  const make = () => {
    const paths = tmpPaths();
    process.env.MTP_DISABLE_KEYRING = '1';
    const creds = new CredentialManager(paths, async () => 'encrypted-file');
    return { paths, storage: new ConnectionStorage(paths, creds) };
  };

  it('creates, lists, renames, favorites, defaults and deletes profiles', async () => {
    const { storage } = make();
    const a = await storage.create({ name: 'Local', kind: 'local', uri: 'mongodb://localhost:27017' });
    const b = await storage.create({ name: 'Remote', kind: 'self-hosted', uri: 'mongodb://db:27017' });
    expect((await storage.getDefault())?.id).toBe(a.id); // first profile becomes default
    await storage.setDefault(b.id);
    expect((await storage.getDefault())?.id).toBe(b.id);
    await storage.toggleFavorite(b.id);
    expect((await storage.list())[0]?.id).toBe(b.id);
    await storage.rename(a.id, 'Laptop');
    expect((await storage.findByName('laptop'))?.id).toBe(a.id);
    await expect(storage.rename(a.id, 'remote')).rejects.toThrow(/already exists/);
    await expect(storage.create({ name: 'Remote', kind: 'local', uri: 'mongodb://x' })).rejects.toThrow(
      /invalid/i,
    );
    await storage.markUsed(a.id);
    expect((await storage.recent())[0]?.id).toBe(a.id);
    await storage.delete(b.id);
    expect(await storage.get(b.id)).toBeUndefined();
    expect(await storage.getDefaultId()).toBeUndefined();
  });

  it('never writes passwords into the profile file', async () => {
    const { paths, storage } = make();
    const p = await storage.create(
      { name: 'Secure', kind: 'local', uri: 'mongodb://bob:TopSecret123@localhost/' },
      { savePassword: true },
    );
    expect(p.username).toBe('bob');
    expect(p.hasStoredPassword).toBe(true);
    const file = readFileSync(paths.connectionsFile, 'utf8');
    expect(file).not.toContain('TopSecret123');
    expect(file).not.toContain('bob:');
    expect(await storage.getPassword(p.id)).toBe('TopSecret123');
    if (process.platform !== 'win32') expect(statSync(paths.connectionsFile).mode & 0o777).toBe(0o600);
  });

  it('keeps session-only passwords out of storage', async () => {
    const { paths, storage } = make();
    const p = await storage.create(
      { name: 'S', kind: 'local', uri: 'mongodb://u:sessiononly@localhost/' },
      { savePassword: false },
    );
    expect(p.hasStoredPassword).toBe(false);
    expect(await storage.getPassword(p.id)).toBe('sessiononly');
    await expect(fs.readFile(paths.credentialsFile, 'utf8')).rejects.toThrow();
  });

  it('updates profiles from the edit form (keep / replace / forget password)', async () => {
    const { storage } = make();
    const p = await storage.create(
      { name: 'E', kind: 'local', uri: 'mongodb://u:one@localhost/' },
      { savePassword: true },
    );
    await storage.updateFromDraft(
      p.id,
      { name: 'E2', kind: 'local', uri: p.uri, username: 'u' },
      { savePassword: true },
    );
    expect(await storage.getPassword(p.id)).toBe('one');
    await storage.updateFromDraft(
      p.id,
      { name: 'E2', kind: 'local', uri: p.uri, username: 'u', password: 'two' },
      { savePassword: true },
    );
    expect(await storage.getPassword(p.id)).toBe('two');
    const forgotten = await storage.updateFromDraft(
      p.id,
      { name: 'E2', kind: 'local', uri: p.uri, username: 'u', password: '' },
      { savePassword: true },
    );
    expect(forgotten.hasStoredPassword).toBe(false);
  });

  it('recovers from a corrupt connections file without losing it', async () => {
    const { paths, storage } = make();
    await fs.mkdir(path.dirname(paths.connectionsFile), { recursive: true });
    await fs.writeFile(paths.connectionsFile, '{ not json');
    expect(await storage.list()).toEqual([]);
    const files = await fs.readdir(path.dirname(paths.connectionsFile));
    expect(files.some((f) => f.startsWith('connections.json.corrupt-'))).toBe(true);
  });
});

describe('MongoDB Compass discovery', () => {
  it('parses modern Compass files without exposing or decrypting secrets', () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURES, 'compass/modern-favorite.json'), 'utf8'));
    const d = parseCompassConnection(raw, 'x.json');
    expect(d?.name).toBe('Production Atlas');
    expect(d?.username).toBe('appuser');
    expect(d?.passwordRequired).toBe(true);
    expect(d?.notes.join(' ')).toMatch(/protected by Compass/);
    expect(d?.uri).not.toContain('appuser');
    expect(JSON.stringify(d)).not.toContain('djEwAAAA');
  });

  it('ignores plain-text passwords embedded in old files', () => {
    const raw = JSON.parse(readFileSync(path.join(FIXTURES, 'compass/plaintext-password.json'), 'utf8'));
    const d = parseCompassConnection(raw, 'x.json');
    expect(JSON.stringify(d)).not.toContain('hunter2');
    expect(d?.passwordRequired).toBe(true);
  });

  it('parses legacy model files and passwordless mechanisms', () => {
    const legacy = parseCompassConnection(
      JSON.parse(readFileSync(path.join(FIXTURES, 'compass/legacy.json'), 'utf8')),
      'l.json',
    );
    expect(legacy?.uri).toContain('rs1.example.com:27018');
    expect(legacy?.uri).toContain('replicaSet=rs1');
    expect(legacy?.uri).toContain('tls=true');
    expect(legacy?.username).toBe('legacyuser');
    const x509 = parseCompassConnection(
      JSON.parse(readFileSync(path.join(FIXTURES, 'compass/x509.json'), 'utf8')),
      'x.json',
    );
    expect(x509?.passwordRequired).toBe(false);
    expect(parseCompassConnection({ not: 'a connection' }, 'g.json')).toBeUndefined();
  });

  it('discovers installations per platform layout, read-only', async () => {
    const home = tmpDir();
    const linuxDir = path.join(home, '.config', 'MongoDB Compass');
    await fs.mkdir(path.join(linuxDir, 'Connections'), { recursive: true });
    await fs.mkdir(path.join(linuxDir, 'AppPreferences'), { recursive: true });
    await fs.writeFile(
      path.join(linuxDir, 'AppPreferences', 'General.json'),
      JSON.stringify({ lastKnownVersion: '1.49.8' }),
    );
    for (const f of await fs.readdir(path.join(FIXTURES, 'compass'))) {
      await fs.copyFile(path.join(FIXTURES, 'compass', f), path.join(linuxDir, 'Connections', f));
    }
    const before = await Promise.all(
      (await fs.readdir(path.join(linuxDir, 'Connections'))).map(async (f) => [
        f,
        await fs.readFile(path.join(linuxDir, 'Connections', f), 'utf8'),
      ]),
    );
    const result = await discoverCompassConnections({ platform: 'linux', home, env: {} });
    expect(result.installed).toBe(true);
    expect(result.installations[0]?.version).toBe('1.49.8');
    expect(result.connections.map((c) => c.name).sort()).toEqual(
      ['Legacy replica', 'Old style', 'Production Atlas', 'X509', 'localhost:27017'].sort(),
    );
    expect(result.warnings.join(' ')).toMatch(/corrupt\.json/);
    for (const [f, content] of before)
      expect(await fs.readFile(path.join(linuxDir, 'Connections', f as string), 'utf8')).toBe(content);

    const winHome = tmpDir();
    const appData = path.join(winHome, 'AppData', 'Roaming');
    await fs.mkdir(path.join(appData, 'MongoDB Compass', 'Connections'), { recursive: true });
    await fs.copyFile(
      path.join(FIXTURES, 'compass/modern-recent.json'),
      path.join(appData, 'MongoDB Compass', 'Connections', 'a.json'),
    );
    if (process.platform !== 'win32') {
      // path.win32 joins with backslashes, which only resolve on Windows; verify the computed roots instead.
      const { compassConfigRoots } = await import('../../src/connection/compass-discovery.js');
      expect(
        compassConfigRoots({
          platform: 'win32',
          home: 'C:\\Users\\me',
          env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
        }),
      ).toEqual(['C:\\Users\\me\\AppData\\Roaming']);
      expect(compassConfigRoots({ platform: 'darwin', home: '/Users/me', env: {} })).toEqual([
        '/Users/me/Library/Application Support',
      ]);
    }
  });

  it('reports "not installed" for a clean home directory', async () => {
    const result = await discoverCompassConnections({ platform: 'linux', home: tmpDir(), env: {} });
    expect(result.connections).toEqual([]);
    expect(result.installations).toEqual([]);
  });

  it('parses Compass export files', async () => {
    const list = await parseCompassExportFile(path.join(FIXTURES, 'compass-export.json'));
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('Exported One');
    expect(list[0]?.passwordRequired).toBe(true);
  });

  it('imports discovered connections and flags missing passwords', async () => {
    const paths = tmpPaths();
    process.env.MTP_DISABLE_KEYRING = '1';
    const storage = new ConnectionStorage(paths, new CredentialManager(paths, async () => 'encrypted-file'));
    const d = parseCompassConnection(
      JSON.parse(readFileSync(path.join(FIXTURES, 'compass/modern-favorite.json'), 'utf8')),
      'x',
    );
    const outcome = await importDiscovered(storage, [d!, d!]);
    expect(outcome.imported.map((p) => p.name)).toEqual(['Production Atlas', 'Production Atlas (2)']);
    expect(outcome.needPassword).toHaveLength(2);
    expect(outcome.imported[0]?.source).toBe('compass');
    expect(markExisting([d!], await storage.list())[0]?.alreadySaved).toBe(true);
  });
});

describe('environment discovery', () => {
  it('parses dotenv syntax without expansion', () => {
    const vars = parseDotEnv('export A="1"\nB=\'two\'\nC=3 # comment\n# x=1\nD: four\nBAD LINE');
    expect(Object.fromEntries(vars)).toEqual({ A: '1', B: 'two', C: '3', D: 'four' });
  });

  it('reads only top-level .env files of the chosen directory', async () => {
    const r = await collectFromProjectDirectory(path.join(FIXTURES, 'project'));
    expect(r.filesRead.map((f) => path.basename(f)).sort()).toEqual(['.env', '.env.local']);
    expect(r.candidates.map((c) => c.variable).sort()).toEqual(['MONGODB_URI', 'MONGO_URI']);
    expect(r.candidates.some((c) => c.value.includes('should-not-be-read'))).toBe(false);
  });

  it('masks values and separates secrets', async () => {
    const r = await collectFromProjectDirectory(path.join(FIXTURES, 'project'));
    const { connections, secrets } = candidatesToConnections(r.candidates);
    const env = connections.find((c) => c.name.startsWith('MONGODB_URI'));
    expect(env?.displayUri).toBe('mongodb://envuser:****@localhost:27017/app?authSource=admin');
    expect(JSON.stringify(connections)).not.toContain('envpass');
    expect([...secrets.values()]).toEqual(['envpass']);
  });

  it('only picks MongoDB URIs from the process environment', () => {
    const found = collectFromEnvironment({
      MONGODB_URI: 'mongodb://x',
      DATABASE_URL: 'postgres://y',
      MY_MONGO: 'mongodb+srv://z.mongodb.net',
      PATH: '/bin',
    });
    expect(found.map((f) => f.variable).sort()).toEqual(['MONGODB_URI', 'MY_MONGO']);
  });

  it('rejects files instead of directories', async () => {
    await expect(collectFromProjectDirectory(path.join(FIXTURES, 'people.csv'))).rejects.toThrow(
      /not a directory/,
    );
  });
});
