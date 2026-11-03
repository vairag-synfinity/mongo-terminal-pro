import { ConnectionString } from 'mongodb-connection-string-url';
import type { ConnectionDraft, ConnectionKind } from './connection-types.js';

export interface NormalizedConnection {
  /** URI without username/password. */
  uri: string;
  username?: string;
  password?: string;
  authSource?: string;
  authMechanism?: string;
  defaultDatabase?: string;
  hosts: string[];
  isSrv: boolean;
}

export function parseConnectionString(uri: string): ConnectionString {
  return new ConnectionString(uri.trim());
}

/**
 * Removes credentials from a URI. The username/password are returned separately so the password
 * can be stored in the credential store and never persisted in the profile.
 */
export function stripCredentials(uri: string): NormalizedConnection {
  const cs = parseConnectionString(uri);
  const username = cs.username ? decodeURIComponent(cs.username) : undefined;
  const password = cs.password ? decodeURIComponent(cs.password) : undefined;
  cs.username = '';
  cs.password = '';
  const params = cs.searchParams;
  const authSource = params.get('authSource') ?? undefined;
  const authMechanism = params.get('authMechanism') ?? undefined;
  const dbPath = cs.pathname.replace(/^\//, '');
  return {
    uri: cs.toString(),
    username,
    password,
    authSource,
    authMechanism,
    defaultDatabase: dbPath ? decodeURIComponent(dbPath) : undefined,
    hosts: cs.hosts,
    isSrv: cs.isSRV,
  };
}

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0|host\.docker\.internal)(:\d+)?$/i;

export function detectKind(uri: string): ConnectionKind {
  try {
    const cs = parseConnectionString(uri);
    if (cs.hosts.some((h) => /\.mongodb\.net(:\d+)?$/i.test(h) || /\.mongodb-dev\.net(:\d+)?$/i.test(h)))
      return 'atlas';
    if (cs.searchParams.get('replicaSet') || cs.hosts.length > 1) return 'replica-set';
    if (cs.hosts.every((h) => LOCAL_HOSTS.test(h))) return 'local';
    return 'self-hosted';
  } catch {
    return 'self-hosted';
  }
}

export function isLocalUri(uri: string): boolean {
  try {
    return parseConnectionString(uri).hosts.every((h) => LOCAL_HOSTS.test(h));
  } catch {
    return false;
  }
}

/** Builds a normalized connection from either a URI or the individual form fields. */
export function buildConnectionFromDraft(draft: ConnectionDraft): NormalizedConnection {
  if (draft.uri && draft.uri.trim() !== '') {
    const normalized = stripCredentials(draft.uri);
    return {
      ...normalized,
      username: draft.username || normalized.username,
      password: draft.password || normalized.password,
      authSource: draft.authSource || normalized.authSource,
      authMechanism: draft.authMechanism || normalized.authMechanism,
      defaultDatabase: draft.defaultDatabase || normalized.defaultDatabase,
    };
  }
  const host = (draft.host ?? 'localhost').trim() || 'localhost';
  const srv = Boolean(draft.srv);
  const hostList = host
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => (srv || /:\d+$/.test(h) || h.startsWith('[') ? h : `${h}:${draft.port ?? 27017}`));
  const params = new URLSearchParams();
  if (draft.replicaSet) params.set('replicaSet', draft.replicaSet);
  if (draft.authSource) params.set('authSource', draft.authSource);
  if (draft.authMechanism) params.set('authMechanism', draft.authMechanism);
  const query = params.toString();
  const db = draft.defaultDatabase ? encodeURIComponent(draft.defaultDatabase) : '';
  const uri = `${srv ? 'mongodb+srv' : 'mongodb'}://${hostList.join(',')}/${db}${query ? `?${query}` : ''}`;
  const cs = parseConnectionString(uri); // validates
  return {
    uri: cs.toString(),
    username: draft.username || undefined,
    password: draft.password || undefined,
    authSource: draft.authSource || undefined,
    authMechanism: draft.authMechanism || undefined,
    defaultDatabase: draft.defaultDatabase || undefined,
    hosts: cs.hosts,
    isSrv: srv,
  };
}

/** Human-readable host summary, e.g. "cluster0.abcde.mongodb.net (SRV)". */
export function describeHosts(uri: string): string {
  try {
    const cs = parseConnectionString(uri);
    const hosts =
      cs.hosts.length > 3
        ? `${cs.hosts.slice(0, 3).join(', ')} +${cs.hosts.length - 3}`
        : cs.hosts.join(', ');
    return cs.isSRV ? `${hosts} (SRV)` : hosts;
  } catch {
    return 'invalid URI';
  }
}
