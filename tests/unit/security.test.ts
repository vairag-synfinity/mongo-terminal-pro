import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConnectionProfileSchema, type ConnectionProfile } from '../../src/connection/connection-types.js';
import { ReadOnlyError, toFriendlyError } from '../../src/core/error-handler.js';
import {
  CredentialManager,
  EncryptedFileBackend,
  MemoryBackend,
} from '../../src/security/credential-manager.js';
import { decrypt, deriveKey, encrypt, generateKey, generateSalt } from '../../src/security/encryption.js';
import { Operations, PermissionManager } from '../../src/security/permission-manager.js';
import {
  maskConnectionString,
  maskSecret,
  redactObject,
  redactText,
} from '../../src/security/sensitive-data-filter.js';
import { tmpPaths } from '../helpers/tmp.js';

describe('sensitive data filter', () => {
  it('masks passwords in connection strings but keeps the user', () => {
    expect(maskConnectionString('mongodb://alice:s3cr%40t@db:27017/app')).toBe(
      'mongodb://alice:****@db:27017/app',
    );
    expect(maskConnectionString('mongodb+srv://bob:pw@cluster0.x.mongodb.net/?a=1')).toBe(
      'mongodb+srv://bob:****@cluster0.x.mongodb.net/?a=1',
    );
    expect(maskConnectionString('mongodb://onlyuser@db/')).toBe('mongodb://onlyuser@db/');
    expect(maskConnectionString('mongodb://db/')).toBe('mongodb://db/');
  });

  it('redacts secrets in free text, query strings and key=value pairs', () => {
    const text =
      'failed for mongodb://u:p4ss@h/ with password=hunter2 and ?tlsCertificateKeyFilePassword=abc&x=1 token: xyz';
    const out = redactText(text);
    expect(out).not.toMatch(/p4ss|hunter2|abc|xyz/);
    expect(out).toContain('mongodb://u:****@h/');
  });

  it('redacts nested objects and errors', () => {
    const out = redactObject({
      password: 'x',
      nested: { uri: 'mongodb://a:b@c', list: ['mongodb://d:e@f'] },
      error: new Error('auth mongodb://g:h@i'),
    });
    expect(JSON.stringify(out)).not.toMatch(/:b@|:e@|:h@|"x"/);
    expect((out.error as Error).message).toContain('g:****@i');
  });

  it('maskSecret never reveals short secrets', () => {
    expect(maskSecret('abc', 2)).toBe('****');
    expect(maskSecret('')).toBe('');
  });

  it('friendly errors are redacted', () => {
    const f = toFriendlyError(new Error('connect ECONNREFUSED mongodb://admin:topsecret@10.0.0.1:27017'));
    expect(f.message).not.toContain('topsecret');
    expect(f.title).toBe('Connection refused');
  });

  it('classifies common MongoDB errors with hints', () => {
    expect(
      toFriendlyError({ name: 'MongoServerSelectionError', message: 'Server selection timed out' }).code,
    ).toBe('CONNECTION');
    expect(toFriendlyError({ code: 18, message: 'Authentication failed.' }).code).toBe('AUTH');
    expect(
      toFriendlyError({ code: 13, codeName: 'Unauthorized', message: 'not authorized on admin' }).code,
    ).toBe('PERMISSION');
    expect(toFriendlyError({ code: 50, message: 'operation exceeded time limit' }).code).toBe('TIMEOUT');
  });
});

describe('encryption', () => {
  it('round-trips with AES-256-GCM and authenticates associated data', () => {
    const key = generateKey();
    const payload = encrypt('my password', key, 'connection:1');
    expect(decrypt(payload, key, 'connection:1')).toBe('my password');
    expect(() => decrypt(payload, key, 'connection:2')).toThrow(/Decryption failed/);
    expect(() => decrypt(payload, generateKey(), 'connection:1')).toThrow(/Decryption failed/);
  });

  it('detects tampering', () => {
    const key = generateKey();
    const payload = encrypt('secret', key);
    const tampered = { ...payload, data: Buffer.from('AAAAAA', 'base64').toString('base64') };
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('derives deterministic keys from passphrases with salt', () => {
    const salt = generateSalt();
    expect(deriveKey('pass', salt).equals(deriveKey('pass', salt))).toBe(true);
    expect(deriveKey('pass', salt).equals(deriveKey('pass', generateSalt()))).toBe(false);
    expect(() => deriveKey('', salt)).toThrow();
  });
});

describe('credential storage', () => {
  it('encrypted file backend never stores plain text and uses private permissions', async () => {
    const paths = tmpPaths();
    const backend = new EncryptedFileBackend(paths, undefined);
    await backend.set('connection:abc', 'Sup3r-Secret!');
    expect(await backend.get('connection:abc')).toBe('Sup3r-Secret!');
    const raw = readFileSync(paths.credentialsFile, 'utf8');
    expect(raw).not.toContain('Sup3r-Secret!');
    if (process.platform !== 'win32') {
      expect(statSync(paths.credentialsFile).mode & 0o777).toBe(0o600);
      expect(statSync(paths.masterKeyFile).mode & 0o777).toBe(0o600);
    }
    await backend.delete('connection:abc');
    expect(await backend.get('connection:abc')).toBeUndefined();
  });

  it('supports a master passphrase and refuses to unlock without it', async () => {
    const paths = tmpPaths();
    await new EncryptedFileBackend(paths, 'correct horse').set('connection:x', 'pw');
    expect(await new EncryptedFileBackend(paths, 'correct horse').get('connection:x')).toBe('pw');
    await expect(new EncryptedFileBackend(paths, 'wrong').get('connection:x')).rejects.toThrow(
      /Decryption failed/,
    );
    await expect(new EncryptedFileBackend(paths, undefined).get('connection:x')).rejects.toThrow(
      /MTP_MASTER_PASSWORD/,
    );
  });

  it('memory backend keeps secrets for the session only', async () => {
    const m = new MemoryBackend();
    await m.set('a', 'b');
    expect(await m.get('a')).toBe('b');
  });

  it('credential manager honours the "none" preference and session cache', async () => {
    const manager = new CredentialManager(tmpPaths(), async () => 'none');
    expect((await manager.backend()).kind).toBe('memory');
    manager.rememberForSession('id1', 'pw1');
    expect(await manager.getPassword('id1')).toBe('pw1');
    await manager.deletePassword('id1');
    expect(await manager.getPassword('id1')).toBeUndefined();
  });

  it('falls back to the encrypted file when the keyring is disabled', async () => {
    process.env.MTP_DISABLE_KEYRING = '1';
    const manager = new CredentialManager(tmpPaths(), async () => 'auto');
    expect((await manager.backend()).kind).toBe('encrypted-file');
    expect(manager.fallbackReason).toBeTruthy();
  });
});

function profile(overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  const now = new Date().toISOString();
  return ConnectionProfileSchema.parse({
    id: 'p1',
    name: 'Prod',
    uri: 'mongodb://h/',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe('permission manager', () => {
  it('starts read-only and blocks writes', () => {
    const pm = new PermissionManager(profile());
    expect(pm.isWriteEnabled).toBe(false);
    expect(pm.check(Operations.insertDocument).allowed).toBe(false);
    expect(() => pm.assert(Operations.deleteDocument)).toThrow(ReadOnlyError);
    expect(pm.check({ name: 'find', risk: 'read' }).allowed).toBe(true);
  });

  it('requires confirmation for destructive operations once writes are enabled', () => {
    const pm = new PermissionManager(profile());
    pm.enableWrites();
    expect(pm.check(Operations.insertDocument)).toEqual({ allowed: true, confirmation: 'none' });
    expect(pm.check(Operations.dropCollection)).toEqual({ allowed: true, confirmation: 'confirm' });
  });

  it('production connections require typing the name', () => {
    const pm = new PermissionManager(profile({ production: true }));
    expect(pm.enableWriteRequirement().confirmation).toBe('type-name');
    expect(() => pm.enableWrites('prod')).toThrow(/did not match/);
    pm.enableWrites('Prod');
    expect(pm.check(Operations.dropDatabase).confirmation).toBe('type-name');
    expect(pm.check(Operations.insertDocument).confirmation).toBe('confirm');
    expect(pm.verifyTypedConfirmation(' Prod ')).toBe(true);
  });

  it('locked read-only connections can never enable writes', () => {
    const pm = new PermissionManager(profile({ readOnlyLocked: true }));
    expect(pm.enableWriteRequirement().allowed).toBe(false);
    expect(() => pm.enableWrites()).toThrow(ReadOnlyError);
  });

  it('switching connection resets to read-only', () => {
    const pm = new PermissionManager(profile());
    pm.enableWrites();
    pm.setProfile(profile({ id: 'p2', name: 'Other' }));
    expect(pm.isWriteEnabled).toBe(false);
  });
});
