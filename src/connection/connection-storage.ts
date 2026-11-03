import { randomUUID } from 'node:crypto';
import { JsonStore } from '../config/json-store.js';
import type { AppPaths } from '../config/paths.js';
import { ValidationError } from '../core/error-handler.js';
import type { CredentialManager } from '../security/credential-manager.js';
import {
  ConnectionProfileSchema,
  ConnectionsFileSchema,
  type ConnectionDraft,
  type ConnectionProfile,
  type ConnectionsFile,
} from './connection-types.js';
import { validateDraft } from './connection-validator.js';
import { buildConnectionFromDraft, detectKind } from './manual-connection.js';

export interface SaveOptions {
  /** Persist the password in the credential store. Otherwise it is only kept for this session. */
  savePassword?: boolean;
}

/** Persists connection profiles (never passwords) and delegates secrets to the CredentialManager. */
export class ConnectionStorage {
  readonly store: JsonStore<ConnectionsFile>;

  constructor(
    paths: AppPaths,
    private readonly credentials: CredentialManager,
  ) {
    this.store = new JsonStore(paths.connectionsFile, ConnectionsFileSchema, () =>
      ConnectionsFileSchema.parse({}),
    );
  }

  async list(): Promise<ConnectionProfile[]> {
    const file = await this.store.read();
    // Favourites first, then most recently used, then name.
    return [...file.profiles].sort((a, b) => {
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      const la = a.lastUsedAt ?? '';
      const lb = b.lastUsedAt ?? '';
      if (la !== lb) return la < lb ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }

  async get(id: string): Promise<ConnectionProfile | undefined> {
    return (await this.store.read()).profiles.find((p) => p.id === id);
  }

  async findByName(name: string): Promise<ConnectionProfile | undefined> {
    const lower = name.toLowerCase();
    const profiles = (await this.store.read()).profiles;
    return profiles.find((p) => p.name.toLowerCase() === lower) ?? profiles.find((p) => p.id === name);
  }

  async getDefault(): Promise<ConnectionProfile | undefined> {
    const file = await this.store.read();
    if (file.defaultConnectionId) {
      const p = file.profiles.find((x) => x.id === file.defaultConnectionId);
      if (p) return p;
    }
    return file.profiles.length === 1 ? file.profiles[0] : undefined;
  }

  async getDefaultId(): Promise<string | undefined> {
    return (await this.store.read()).defaultConnectionId;
  }

  async create(draft: ConnectionDraft, options: SaveOptions = {}): Promise<ConnectionProfile> {
    const existing = (await this.store.read()).profiles.map((p) => p.name);
    const validation = validateDraft(draft, existing);
    if (!validation.valid) {
      throw new ValidationError(
        'Connection is invalid',
        Object.values(validation.errors).filter(Boolean) as string[],
      );
    }
    const normalized = buildConnectionFromDraft(draft);
    const now = new Date().toISOString();
    const profile = ConnectionProfileSchema.parse({
      id: randomUUID(),
      name: draft.name.trim(),
      kind: draft.kind ?? detectKind(normalized.uri),
      uri: normalized.uri,
      username: normalized.username,
      authSource: normalized.authSource,
      authMechanism: normalized.authMechanism,
      defaultDatabase: normalized.defaultDatabase,
      tls: {
        mode: draft.tls?.mode ?? 'default',
        caFile: draft.tls?.caFile || undefined,
        certificateKeyFile: draft.tls?.certificateKeyFile || undefined,
        allowInvalidCertificates: draft.tls?.allowInvalidCertificates ?? false,
        allowInvalidHostnames: draft.tls?.allowInvalidHostnames ?? false,
      },
      connectTimeoutMs: draft.connectTimeoutMs,
      production: draft.production ?? false,
      readOnlyLocked: draft.readOnlyLocked ?? false,
      favorite: draft.favorite ?? false,
      notes: draft.notes,
      source: draft.source ?? 'manual',
      hasStoredPassword: false,
      createdAt: now,
      updatedAt: now,
    });
    if (normalized.password) {
      if (options.savePassword) {
        await this.credentials.savePassword(profile.id, normalized.password);
        profile.hasStoredPassword = true;
      } else {
        this.credentials.rememberForSession(profile.id, normalized.password);
      }
    }
    await this.store.update((f) => {
      f.profiles.push(profile);
      if (f.profiles.length === 1) f.defaultConnectionId = profile.id;
    });
    return profile;
  }

  /** Updates a profile from a draft (the edit form). Password: undefined = keep, '' = remove. */
  async updateFromDraft(
    id: string,
    draft: ConnectionDraft,
    options: SaveOptions = {},
  ): Promise<ConnectionProfile> {
    const current = await this.require(id);
    const others = (await this.store.read()).profiles.filter((p) => p.id !== id).map((p) => p.name);
    const validation = validateDraft(draft, others);
    if (!validation.valid) {
      throw new ValidationError(
        'Connection is invalid',
        Object.values(validation.errors).filter(Boolean) as string[],
      );
    }
    const normalized = buildConnectionFromDraft(draft);
    const updated: ConnectionProfile = ConnectionProfileSchema.parse({
      ...current,
      name: draft.name.trim(),
      kind: draft.kind ?? current.kind,
      uri: normalized.uri,
      username: normalized.username,
      authSource: normalized.authSource,
      authMechanism: normalized.authMechanism,
      defaultDatabase: normalized.defaultDatabase,
      tls: { ...current.tls, ...draft.tls },
      connectTimeoutMs: draft.connectTimeoutMs,
      production: draft.production ?? current.production,
      readOnlyLocked: draft.readOnlyLocked ?? current.readOnlyLocked,
      favorite: draft.favorite ?? current.favorite,
      notes: draft.notes ?? current.notes,
      updatedAt: new Date().toISOString(),
    });
    if (draft.password === '') {
      await this.credentials.deletePassword(id);
      updated.hasStoredPassword = false;
    } else if (normalized.password) {
      if (options.savePassword) {
        await this.credentials.savePassword(id, normalized.password);
        updated.hasStoredPassword = true;
      } else {
        await this.credentials.deletePassword(id);
        this.credentials.rememberForSession(id, normalized.password);
        updated.hasStoredPassword = false;
      }
    }
    if (!normalized.username) {
      await this.credentials.deletePassword(id);
      updated.hasStoredPassword = false;
    }
    await this.replace(updated);
    return updated;
  }

  async patch(
    id: string,
    patch: Partial<Omit<ConnectionProfile, 'id' | 'createdAt'>>,
  ): Promise<ConnectionProfile> {
    const current = await this.require(id);
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (!trimmed) throw new ValidationError('Connection name is required');
      const clash = (await this.store.read()).profiles.some(
        (p) => p.id !== id && p.name.toLowerCase() === trimmed.toLowerCase(),
      );
      if (clash) throw new ValidationError(`A connection named "${trimmed}" already exists`);
      patch.name = trimmed;
    }
    const updated = ConnectionProfileSchema.parse({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await this.replace(updated);
    return updated;
  }

  rename(id: string, name: string): Promise<ConnectionProfile> {
    return this.patch(id, { name });
  }

  async toggleFavorite(id: string): Promise<ConnectionProfile> {
    const current = await this.require(id);
    return this.patch(id, { favorite: !current.favorite });
  }

  async setDefault(id: string | undefined): Promise<void> {
    if (id) await this.require(id);
    await this.store.update((f) => {
      f.defaultConnectionId = id;
    });
  }

  async markUsed(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.store.update((f) => {
      const p = f.profiles.find((x) => x.id === id);
      if (p) p.lastUsedAt = now;
      f.recentConnectionIds = [id, ...f.recentConnectionIds.filter((x) => x !== id)].slice(0, 10);
    });
  }

  async recent(): Promise<ConnectionProfile[]> {
    const file = await this.store.read();
    return file.recentConnectionIds
      .map((id) => file.profiles.find((p) => p.id === id))
      .filter((p): p is ConnectionProfile => Boolean(p));
  }

  async delete(id: string): Promise<void> {
    await this.require(id);
    await this.credentials.deletePassword(id).catch(() => undefined);
    await this.store.update((f) => {
      f.profiles = f.profiles.filter((p) => p.id !== id);
      f.recentConnectionIds = f.recentConnectionIds.filter((x) => x !== id);
      if (f.defaultConnectionId === id) f.defaultConnectionId = undefined;
    });
  }

  async setPassword(id: string, password: string, persist: boolean): Promise<void> {
    if (persist) {
      await this.credentials.savePassword(id, password);
      await this.patch(id, { hasStoredPassword: true });
    } else {
      this.credentials.rememberForSession(id, password);
    }
  }

  getPassword(id: string): Promise<string | undefined> {
    return this.credentials.getPassword(id);
  }

  private async require(id: string): Promise<ConnectionProfile> {
    const p = await this.get(id);
    if (!p) throw new ValidationError(`Connection ${id} not found`);
    return p;
  }

  private async replace(profile: ConnectionProfile): Promise<void> {
    await this.store.update((f) => {
      f.profiles = f.profiles.map((p) => (p.id === profile.id ? profile : p));
    });
  }
}

/** Converts a profile back into a draft for the edit form (no password). */
export function profileToDraft(profile: ConnectionProfile): ConnectionDraft {
  return {
    name: profile.name,
    kind: profile.kind,
    uri: profile.uri,
    username: profile.username,
    authSource: profile.authSource,
    authMechanism: profile.authMechanism,
    defaultDatabase: profile.defaultDatabase,
    tls: profile.tls,
    connectTimeoutMs: profile.connectTimeoutMs,
    production: profile.production,
    readOnlyLocked: profile.readOnlyLocked,
    favorite: profile.favorite,
    notes: profile.notes,
    source: profile.source,
  };
}
