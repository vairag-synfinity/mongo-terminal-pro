import { MongoClient, type MongoClientOptions } from 'mongodb';
import { AppError, NotConnectedError } from '../core/error-handler.js';
import type { EventManager } from '../core/event-manager.js';
import type { Logger } from '../core/logger.js';
import { redactText } from '../security/sensitive-data-filter.js';
import type { ConnectionProfile, ServerInfo, TopologyKind } from './connection-types.js';
import { describeHosts } from './manual-connection.js';

export interface ConnectionTuning {
  connectTimeoutMs: number;
  maxPoolSize: number;
}

export interface TestResult {
  ok: boolean;
  latencyMs: number;
  server?: ServerInfo;
  error?: unknown;
}

const APP_NAME = 'mongo-terminal-pro';

/** Builds driver options. Credentials go through `auth`, never through the URI string. */
export function buildClientOptions(
  profile: Pick<ConnectionProfile, 'username' | 'authSource' | 'authMechanism' | 'tls' | 'connectTimeoutMs'>,
  password: string | undefined,
  tuning: ConnectionTuning,
): MongoClientOptions {
  const timeout = profile.connectTimeoutMs ?? tuning.connectTimeoutMs;
  const options: MongoClientOptions = {
    appName: APP_NAME,
    serverSelectionTimeoutMS: timeout,
    connectTimeoutMS: timeout,
    maxPoolSize: tuning.maxPoolSize,
    minPoolSize: 0,
    maxIdleTimeMS: 60_000,
    retryWrites: true,
    retryReads: true,
  };
  if (profile.username) {
    options.auth = { username: profile.username, password };
  }
  if (profile.authSource) options.authSource = profile.authSource;
  if (profile.authMechanism)
    options.authMechanism = profile.authMechanism as MongoClientOptions['authMechanism'];
  const tls = profile.tls;
  if (tls) {
    if (tls.mode === 'on') options.tls = true;
    if (tls.mode === 'off') options.tls = false;
    if (tls.caFile) options.tlsCAFile = tls.caFile;
    if (tls.certificateKeyFile) options.tlsCertificateKeyFile = tls.certificateKeyFile;
    if (tls.allowInvalidCertificates) options.tlsAllowInvalidCertificates = true;
    if (tls.allowInvalidHostnames) options.tlsAllowInvalidHostnames = true;
  }
  return options;
}

interface HelloResponse {
  setName?: string;
  primary?: string;
  hosts?: string[];
  msg?: string;
  isWritablePrimary?: boolean;
  ismaster?: boolean;
  maxWireVersion?: number;
  serviceId?: unknown;
}

export async function readServerInfo(client: MongoClient, uri: string): Promise<ServerInfo> {
  const admin = client.db('admin');
  const hello = (await admin
    .command({ hello: 1 })
    .catch(() => admin.command({ isMaster: 1 }))) as HelloResponse;
  const build = (await admin.command({ buildInfo: 1 }).catch(() => ({ version: 'unknown' }))) as {
    version?: string;
  };
  let topology: TopologyKind = 'standalone';
  if (hello.msg === 'isdbgrid') topology = 'sharded';
  else if (hello.setName) topology = 'replica-set';
  else if (hello.serviceId !== undefined) topology = 'load-balanced';
  const displayHosts = describeHosts(uri);
  return {
    version: build.version ?? 'unknown',
    topology,
    isAtlas: /mongodb(-dev)?\.net/i.test(displayHosts),
    replicaSetName: hello.setName,
    primary: hello.primary,
    hosts: hello.hosts,
    isWritablePrimary: hello.isWritablePrimary ?? hello.ismaster,
    maxWireVersion: hello.maxWireVersion,
    displayHosts,
  };
}

/**
 * Owns the single active MongoClient. The driver maintains the connection pool; screens obtain the
 * client through `getClient()` so there is exactly one pool per active connection.
 */
export class ConnectionManager {
  private client: MongoClient | undefined;
  private profile: ConnectionProfile | undefined;
  private server: ServerInfo | undefined;
  private connectedAt: Date | undefined;

  constructor(
    private readonly events: EventManager,
    private readonly logger: Logger,
    private readonly tuning: () => Promise<ConnectionTuning>,
  ) {}

  get isConnected(): boolean {
    return this.client !== undefined;
  }

  get activeProfile(): ConnectionProfile | undefined {
    return this.profile;
  }

  get serverInfo(): ServerInfo | undefined {
    return this.server;
  }

  get connectedSince(): Date | undefined {
    return this.connectedAt;
  }

  getClient(): MongoClient {
    if (!this.client) throw new NotConnectedError();
    return this.client;
  }

  async connect(profile: ConnectionProfile, password: string | undefined): Promise<ServerInfo> {
    await this.disconnect();
    if (profile.username && password === undefined && needsPassword(profile)) {
      throw new AppError(`A password is required for "${profile.name}"`, 'AUTH');
    }
    const options = buildClientOptions(profile, password, await this.tuning());
    const client = new MongoClient(profile.uri, options);
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      const server = await readServerInfo(client, profile.uri);
      this.client = client;
      this.profile = profile;
      this.server = server;
      this.connectedAt = new Date();
      this.logger.info(
        { connection: profile.name, topology: server.topology, version: server.version },
        'connected',
      );
      this.events.emit('connection:connected', { profile, server });
      return server;
    } catch (error) {
      await client.close(true).catch(() => undefined);
      const message = redactText((error as Error).message ?? String(error));
      this.logger.warn({ connection: profile.name, error: message }, 'connection failed');
      this.events.emit('connection:error', { profileId: profile.id, message });
      throw error;
    }
  }

  /** Opens a short-lived client to verify settings without changing the active connection. */
  async test(
    profile: Pick<
      ConnectionProfile,
      'uri' | 'username' | 'authSource' | 'authMechanism' | 'tls' | 'connectTimeoutMs'
    >,
    password: string | undefined,
  ): Promise<TestResult> {
    const started = Date.now();
    const client = new MongoClient(profile.uri, buildClientOptions(profile, password, await this.tuning()));
    try {
      await client.connect();
      await client.db('admin').command({ ping: 1 });
      const server = await readServerInfo(client, profile.uri);
      return { ok: true, latencyMs: Date.now() - started, server };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, error };
    } finally {
      await client.close(true).catch(() => undefined);
    }
  }

  async ping(): Promise<number> {
    const started = Date.now();
    await this.getClient().db('admin').command({ ping: 1 });
    return Date.now() - started;
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    const profile = this.profile;
    this.client = undefined;
    this.profile = undefined;
    this.server = undefined;
    this.connectedAt = undefined;
    if (client) {
      await client.close().catch(() => undefined);
      if (profile) {
        this.logger.info({ connection: profile.name }, 'disconnected');
        this.events.emit('connection:disconnected', { profileId: profile.id });
      }
    }
  }
}

/** Mechanisms that authenticate without a password. */
export function needsPassword(profile: Pick<ConnectionProfile, 'authMechanism'>): boolean {
  const mech = profile.authMechanism?.toUpperCase();
  return !(mech === 'MONGODB-X509' || mech === 'MONGODB-AWS' || mech === 'GSSAPI' || mech === 'MONGODB-OIDC');
}
