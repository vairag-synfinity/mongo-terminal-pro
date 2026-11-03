import { z } from 'zod';

export const ConnectionKindSchema = z.enum(['local', 'atlas', 'self-hosted', 'replica-set', 'sharded']);
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>;

export const ConnectionSourceSchema = z.enum(['manual', 'compass', 'env', 'config-import', 'cli']);
export type ConnectionSource = z.infer<typeof ConnectionSourceSchema>;

export const TlsModeSchema = z.enum(['default', 'on', 'off']);

export const TlsConfigSchema = z.object({
  /** default = whatever the URI says (mongodb+srv implies TLS). */
  mode: TlsModeSchema.default('default'),
  caFile: z.string().optional(),
  certificateKeyFile: z.string().optional(),
  /** Insecure; requires explicit opt-in and is surfaced as a warning in the UI. */
  allowInvalidCertificates: z.boolean().default(false),
  allowInvalidHostnames: z.boolean().default(false),
});
export type TlsConfig = z.infer<typeof TlsConfigSchema>;

/**
 * A saved connection profile. The URI stored here NEVER contains a password: credentials are kept
 * in the credential store and supplied to the driver through the `auth` option at connect time.
 */
export const ConnectionProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  kind: ConnectionKindSchema.default('self-hosted'),
  uri: z.string().min(1),
  username: z.string().optional(),
  authSource: z.string().optional(),
  authMechanism: z.string().optional(),
  defaultDatabase: z.string().optional(),
  tls: TlsConfigSchema.default({
    mode: 'default',
    allowInvalidCertificates: false,
    allowInvalidHostnames: false,
  }),
  connectTimeoutMs: z.number().int().min(500).max(120_000).optional(),
  /** Hard lock: when true, write access cannot be enabled for this connection at all. */
  readOnlyLocked: z.boolean().default(false),
  /** Production connections get stronger confirmations (type the connection name). */
  production: z.boolean().default(false),
  favorite: z.boolean().default(false),
  color: z.string().optional(),
  source: ConnectionSourceSchema.default('manual'),
  hasStoredPassword: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastUsedAt: z.string().optional(),
});
export type ConnectionProfile = z.infer<typeof ConnectionProfileSchema>;

export const ConnectionsFileSchema = z.object({
  version: z.literal(1).default(1),
  defaultConnectionId: z.string().optional(),
  recentConnectionIds: z.array(z.string()).default([]),
  profiles: z.array(ConnectionProfileSchema).default([]),
});
export type ConnectionsFile = z.infer<typeof ConnectionsFileSchema>;

export interface ConnectionDraft {
  name: string;
  kind: ConnectionKind;
  uri?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  authSource?: string;
  authMechanism?: string;
  defaultDatabase?: string;
  replicaSet?: string;
  srv?: boolean;
  tls?: Partial<TlsConfig>;
  connectTimeoutMs?: number;
  production?: boolean;
  readOnlyLocked?: boolean;
  favorite?: boolean;
  notes?: string;
  source?: ConnectionSource;
}

export type TopologyKind = 'standalone' | 'replica-set' | 'sharded' | 'load-balanced' | 'unknown';

export interface ServerInfo {
  version: string;
  topology: TopologyKind;
  isAtlas: boolean;
  replicaSetName?: string;
  primary?: string;
  hosts?: string[];
  isWritablePrimary?: boolean;
  maxWireVersion?: number;
  /** Host list as seen by the driver, never including credentials. */
  displayHosts: string;
}

export interface DiscoveredConnection {
  /** Stable key within the discovery result. */
  key: string;
  name: string;
  source: 'compass' | 'env';
  /** Location the connection was read from (file path or env var name). */
  origin: string;
  /** URI with credentials removed. */
  uri: string;
  username?: string;
  /** True if a password exists but could not (or must not) be recovered; user must enter it. */
  passwordRequired: boolean;
  /** Masked value suitable for display. */
  displayUri: string;
  favorite?: boolean;
  notes: string[];
}
