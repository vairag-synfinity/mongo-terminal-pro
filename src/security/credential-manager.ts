import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { readJsonFile, writeFileAtomic } from '../config/json-store.js';
import type { AppPaths } from '../config/paths.js';
import { decrypt, deriveKey, encrypt, generateKey, generateSalt, KEY_LENGTH } from './encryption.js';

/**
 * Credential storage.
 *
 * Preferred: the operating-system credential store via @napi-rs/keyring
 *   - Windows Credential Manager, macOS Keychain, Linux Secret Service (GNOME Keyring / KWallet).
 * Fallback: an AES-256-GCM encrypted file in the config directory. The key is either
 *   - derived from MTP_MASTER_PASSWORD with scrypt (strong; the secret never touches disk), or
 *   - a random 256-bit key in `master.key` (mode 0600). This protects against accidental disclosure
 *     (config sync, screenshots, copying the config folder without the key) but NOT against
 *     someone who can read files as your user. This trade-off is documented in docs/security.
 * 'none': passwords are never persisted and are requested each session.
 */

export const KEYRING_SERVICE = 'mongo-terminal-pro';

export type CredentialBackendKind = 'keyring' | 'encrypted-file' | 'memory';

export interface CredentialBackend {
  readonly kind: CredentialBackendKind;
  readonly description: string;
  get(id: string): Promise<string | undefined>;
  set(id: string, secret: string): Promise<void>;
  delete(id: string): Promise<void>;
}

interface KeyringModule {
  AsyncEntry: new (
    service: string,
    username: string,
  ) => {
    setPassword(password: string): Promise<void>;
    getPassword(): Promise<string | null | undefined>;
    deletePassword(): Promise<boolean>;
  };
}

async function loadKeyring(): Promise<KeyringModule | undefined> {
  try {
    const mod = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
    return typeof mod.AsyncEntry === 'function' ? mod : undefined;
  } catch {
    return undefined;
  }
}

export class KeyringBackend implements CredentialBackend {
  readonly kind = 'keyring' as const;
  readonly description: string;

  private constructor(private readonly keyring: KeyringModule) {
    const store =
      process.platform === 'win32'
        ? 'Windows Credential Manager'
        : process.platform === 'darwin'
          ? 'macOS Keychain'
          : 'Secret Service (GNOME Keyring / KWallet)';
    this.description = `OS credential store: ${store}`;
  }

  /** Returns a backend only if the keyring can actually store and read back a value. */
  static async create(): Promise<KeyringBackend | undefined> {
    const keyring = await loadKeyring();
    if (!keyring) return undefined;
    const probe = new keyring.AsyncEntry(KEYRING_SERVICE, `probe-${process.pid}`);
    try {
      await withTimeout(probe.setPassword('probe'), 4000);
      const value = await withTimeout(probe.getPassword(), 4000);
      await withTimeout(probe.deletePassword(), 4000).catch(() => undefined);
      return value === 'probe' ? new KeyringBackend(keyring) : undefined;
    } catch {
      return undefined;
    }
  }

  async get(id: string): Promise<string | undefined> {
    const value = await new this.keyring.AsyncEntry(KEYRING_SERVICE, id).getPassword();
    return value ?? undefined;
  }

  async set(id: string, secret: string): Promise<void> {
    await new this.keyring.AsyncEntry(KEYRING_SERVICE, id).setPassword(secret);
  }

  async delete(id: string): Promise<void> {
    try {
      await new this.keyring.AsyncEntry(KEYRING_SERVICE, id).deletePassword();
    } catch {
      // Missing entries are fine.
    }
  }
}

const EncryptedFileSchema = z.object({
  version: z.literal(1),
  keySource: z.enum(['passphrase', 'keyfile']),
  salt: z.string().optional(),
  entries: z.record(z.string(), z.object({ iv: z.string(), tag: z.string(), data: z.string() })),
});
type EncryptedFile = z.infer<typeof EncryptedFileSchema>;

export class EncryptedFileBackend implements CredentialBackend {
  readonly kind = 'encrypted-file' as const;
  readonly description: string;
  private key: Buffer | undefined;

  constructor(
    private readonly paths: AppPaths,
    private readonly passphrase: string | undefined = process.env.MTP_MASTER_PASSWORD,
  ) {
    this.description = passphrase
      ? 'Encrypted file (AES-256-GCM, key derived from MTP_MASTER_PASSWORD)'
      : 'Encrypted file (AES-256-GCM, local key file)';
  }

  private async load(): Promise<EncryptedFile> {
    const raw = await readJsonFile(this.paths.credentialsFile);
    if (raw === undefined) {
      return {
        version: 1,
        keySource: this.passphrase ? 'passphrase' : 'keyfile',
        salt: this.passphrase ? generateSalt().toString('base64') : undefined,
        entries: {},
      };
    }
    return EncryptedFileSchema.parse(raw);
  }

  private async resolveKey(file: EncryptedFile): Promise<Buffer> {
    if (this.key) return this.key;
    if (file.keySource === 'passphrase') {
      if (!this.passphrase) {
        throw new Error(
          'Credentials are protected by a master password. Set MTP_MASTER_PASSWORD to unlock them.',
        );
      }
      this.key = deriveKey(this.passphrase, Buffer.from(file.salt ?? '', 'base64'));
      return this.key;
    }
    try {
      const keyData = await fs.readFile(this.paths.masterKeyFile);
      const key = Buffer.from(keyData.toString('utf8').trim(), 'base64');
      if (key.length !== KEY_LENGTH) throw new Error('Invalid master key file');
      this.key = key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (Object.keys(file.entries).length > 0) {
        throw new Error(
          'The master key file is missing; stored passwords cannot be decrypted and must be re-entered.',
          { cause: error },
        );
      }
      const key = generateKey();
      await writeFileAtomic(this.paths.masterKeyFile, key.toString('base64'), 0o600);
      this.key = key;
    }
    return this.key;
  }

  async get(id: string): Promise<string | undefined> {
    const file = await this.load();
    const entry = file.entries[id];
    if (!entry) return undefined;
    return decrypt(entry, await this.resolveKey(file), id);
  }

  async set(id: string, secret: string): Promise<void> {
    const file = await this.load();
    const key = await this.resolveKey(file);
    file.entries[id] = encrypt(secret, key, id);
    await writeFileAtomic(this.paths.credentialsFile, `${JSON.stringify(file, null, 2)}\n`, 0o600);
  }

  async delete(id: string): Promise<void> {
    const file = await this.load();
    if (!(id in file.entries)) return;
    delete file.entries[id];
    await writeFileAtomic(this.paths.credentialsFile, `${JSON.stringify(file, null, 2)}\n`, 0o600);
  }
}

export class MemoryBackend implements CredentialBackend {
  readonly kind = 'memory' as const;
  readonly description = 'Session only (passwords are not persisted)';
  private readonly secrets = new Map<string, string>();

  async get(id: string): Promise<string | undefined> {
    return this.secrets.get(id);
  }

  async set(id: string, secret: string): Promise<void> {
    this.secrets.set(id, secret);
  }

  async delete(id: string): Promise<void> {
    this.secrets.delete(id);
  }
}

export type CredentialStoragePreference = 'auto' | 'keyring' | 'encrypted-file' | 'none';

/**
 * Facade used by the rest of the app. Also keeps an in-memory session cache so a password entered
 * once (and not saved) is reused until the app exits.
 */
export class CredentialManager {
  private backendPromise: Promise<CredentialBackend> | undefined;
  private readonly session = new Map<string, string>();
  public fallbackReason: string | undefined;

  constructor(
    private readonly paths: AppPaths,
    private readonly preference: () => Promise<CredentialStoragePreference>,
  ) {}

  backend(): Promise<CredentialBackend> {
    this.backendPromise ??= this.selectBackend();
    return this.backendPromise;
  }

  private async selectBackend(): Promise<CredentialBackend> {
    const pref = await this.preference();
    if (pref === 'none') return new MemoryBackend();
    if (pref === 'encrypted-file') return new EncryptedFileBackend(this.paths);
    const keyring = process.env.MTP_DISABLE_KEYRING === '1' ? undefined : await KeyringBackend.create();
    if (keyring) return keyring;
    this.fallbackReason =
      pref === 'keyring'
        ? 'The OS credential store is unavailable; using the encrypted file fallback.'
        : 'No usable OS credential store was found (common on headless Linux/SSH); using the encrypted file fallback.';
    return new EncryptedFileBackend(this.paths);
  }

  async getPassword(connectionId: string): Promise<string | undefined> {
    const cached = this.session.get(connectionId);
    if (cached !== undefined) return cached;
    const backend = await this.backend();
    const value = await backend.get(`connection:${connectionId}`);
    if (value !== undefined) this.session.set(connectionId, value);
    return value;
  }

  async savePassword(connectionId: string, password: string): Promise<CredentialBackendKind> {
    const backend = await this.backend();
    await backend.set(`connection:${connectionId}`, password);
    this.session.set(connectionId, password);
    return backend.kind;
  }

  rememberForSession(connectionId: string, password: string): void {
    this.session.set(connectionId, password);
  }

  async deletePassword(connectionId: string): Promise<void> {
    this.session.delete(connectionId);
    const backend = await this.backend();
    await backend.delete(`connection:${connectionId}`);
  }

  forgetSession(): void {
    this.session.clear();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
