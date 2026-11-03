import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { ConnectionsFileSchema, type ConnectionsFile } from '../connection/connection-types.js';
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from './defaults.js';
import { JsonStore, readJsonFile, writeFileAtomic } from './json-store.js';
import type { AppPaths } from './paths.js';

export class ConfigurationManager {
  readonly store: JsonStore<Settings>;

  constructor(paths: AppPaths) {
    this.store = new JsonStore(paths.settingsFile, SettingsSchema, () => ({ ...DEFAULT_SETTINGS }));
  }

  get(): Promise<Settings> {
    return this.store.read();
  }

  async set<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings> {
    return this.store.update((s) => {
      s[key] = value;
    });
  }

  async patch(values: Partial<Settings>): Promise<Settings> {
    return this.store.update((s) => ({ ...s, ...values }));
  }

  async reset(): Promise<Settings> {
    await this.store.write({ ...DEFAULT_SETTINGS });
    return this.store.read();
  }
}

// ---------------------------------------------------------------------------------------------
// Query history, saved queries and saved pipelines
// ---------------------------------------------------------------------------------------------

export const QueryOperationSchema = z.enum([
  'find',
  'findOne',
  'count',
  'distinct',
  'updateOne',
  'updateMany',
  'deleteOne',
  'deleteMany',
]);
export type QueryOperation = z.infer<typeof QueryOperationSchema>;

export const StoredQuerySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  database: z.string(),
  collection: z.string(),
  operation: QueryOperationSchema,
  filter: z.string().default('{}'),
  projection: z.string().default(''),
  sort: z.string().default(''),
  update: z.string().default(''),
  distinctField: z.string().default(''),
  limit: z.number().int().min(0).default(20),
  skip: z.number().int().min(0).default(0),
  executedAt: z.string().optional(),
  createdAt: z.string(),
});
export type StoredQuery = z.infer<typeof StoredQuerySchema>;

export const StoredPipelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  database: z.string(),
  collection: z.string(),
  stages: z.array(z.object({ operator: z.string(), body: z.string(), enabled: z.boolean().default(true) })),
  createdAt: z.string(),
});
export type StoredPipeline = z.infer<typeof StoredPipelineSchema>;

export const HistoryFileSchema = z.object({
  version: z.literal(1).default(1),
  queryHistory: z.array(StoredQuerySchema).default([]),
  savedQueries: z.array(StoredQuerySchema).default([]),
  savedPipelines: z.array(StoredPipelineSchema).default([]),
});
export type HistoryFile = z.infer<typeof HistoryFileSchema>;

export class HistoryManager {
  readonly store: JsonStore<HistoryFile>;

  constructor(
    paths: AppPaths,
    private readonly limit: () => Promise<number>,
  ) {
    this.store = new JsonStore(paths.historyFile, HistoryFileSchema, () => HistoryFileSchema.parse({}));
  }

  async addHistory(query: Omit<StoredQuery, 'id' | 'createdAt' | 'executedAt'>): Promise<void> {
    const limit = await this.limit();
    if (limit === 0) return;
    const now = new Date().toISOString();
    await this.store.update((h) => {
      // Collapse identical consecutive entries so history stays useful.
      const key = JSON.stringify([
        query.database,
        query.collection,
        query.operation,
        query.filter,
        query.update,
      ]);
      h.queryHistory = h.queryHistory.filter(
        (q) => JSON.stringify([q.database, q.collection, q.operation, q.filter, q.update]) !== key,
      );
      h.queryHistory.unshift({ ...query, id: randomUUID(), createdAt: now, executedAt: now });
      h.queryHistory = h.queryHistory.slice(0, limit);
    });
  }

  async listHistory(): Promise<StoredQuery[]> {
    return (await this.store.read()).queryHistory;
  }

  async clearHistory(): Promise<void> {
    await this.store.update((h) => {
      h.queryHistory = [];
    });
  }

  async saveQuery(query: Omit<StoredQuery, 'id' | 'createdAt'> & { name: string }): Promise<StoredQuery> {
    const saved: StoredQuery = { ...query, id: randomUUID(), createdAt: new Date().toISOString() };
    await this.store.update((h) => {
      h.savedQueries = [saved, ...h.savedQueries.filter((q) => q.name !== query.name)];
    });
    return saved;
  }

  async listSavedQueries(): Promise<StoredQuery[]> {
    return (await this.store.read()).savedQueries;
  }

  async deleteSavedQuery(id: string): Promise<void> {
    await this.store.update((h) => {
      h.savedQueries = h.savedQueries.filter((q) => q.id !== id);
    });
  }

  async savePipeline(pipeline: Omit<StoredPipeline, 'id' | 'createdAt'>): Promise<StoredPipeline> {
    const saved: StoredPipeline = { ...pipeline, id: randomUUID(), createdAt: new Date().toISOString() };
    await this.store.update((h) => {
      h.savedPipelines = [saved, ...h.savedPipelines.filter((p) => p.name !== pipeline.name)];
    });
    return saved;
  }

  async listPipelines(): Promise<StoredPipeline[]> {
    return (await this.store.read()).savedPipelines;
  }

  async deletePipeline(id: string): Promise<void> {
    await this.store.update((h) => {
      h.savedPipelines = h.savedPipelines.filter((p) => p.id !== id);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Configuration backup / restore (never contains secrets)
// ---------------------------------------------------------------------------------------------

export const ConfigBackupSchema = z.object({
  format: z.literal('mongo-terminal-pro-config'),
  version: z.literal(1),
  createdAt: z.string(),
  settings: SettingsSchema,
  connections: ConnectionsFileSchema,
  savedQueries: z.array(StoredQuerySchema).default([]),
  savedPipelines: z.array(StoredPipelineSchema).default([]),
});
export type ConfigBackup = z.infer<typeof ConfigBackupSchema>;

export async function createConfigBackup(paths: AppPaths, outFile: string): Promise<ConfigBackup> {
  const settings = SettingsSchema.parse((await readJsonFile(paths.settingsFile)) ?? {});
  const connections: ConnectionsFile = ConnectionsFileSchema.parse(
    (await readJsonFile(paths.connectionsFile)) ?? {},
  );
  const history = HistoryFileSchema.parse((await readJsonFile(paths.historyFile)) ?? {});
  const backup: ConfigBackup = {
    format: 'mongo-terminal-pro-config',
    version: 1,
    createdAt: new Date().toISOString(),
    settings,
    // Profiles never contain passwords; the credential-store flag is reset because the target
    // machine will not have the secret.
    connections: {
      ...connections,
      profiles: connections.profiles.map((p) => ({ ...p, hasStoredPassword: false })),
    },
    savedQueries: history.savedQueries,
    savedPipelines: history.savedPipelines,
  };
  await writeFileAtomic(outFile, `${JSON.stringify(backup, null, 2)}\n`);
  return backup;
}

export interface ConfigRestoreResult {
  connections: number;
  savedQueries: number;
  savedPipelines: number;
}

export async function restoreConfigBackup(
  paths: AppPaths,
  inFile: string,
  options: { merge: boolean },
): Promise<ConfigRestoreResult> {
  const text = await fs.readFile(inFile, 'utf8');
  const backup = ConfigBackupSchema.parse(JSON.parse(text));
  await writeFileAtomic(paths.settingsFile, `${JSON.stringify(backup.settings, null, 2)}\n`);

  const existingConnections = ConnectionsFileSchema.parse((await readJsonFile(paths.connectionsFile)) ?? {});
  const profiles = options.merge
    ? [
        ...existingConnections.profiles,
        ...backup.connections.profiles.filter(
          (p) => !existingConnections.profiles.some((e) => e.id === p.id),
        ),
      ]
    : backup.connections.profiles;
  const connections: ConnectionsFile = {
    ...backup.connections,
    profiles,
    defaultConnectionId: options.merge
      ? (existingConnections.defaultConnectionId ?? backup.connections.defaultConnectionId)
      : backup.connections.defaultConnectionId,
  };
  await writeFileAtomic(paths.connectionsFile, `${JSON.stringify(connections, null, 2)}\n`);

  const history = HistoryFileSchema.parse((await readJsonFile(paths.historyFile)) ?? {});
  history.savedQueries = options.merge
    ? [
        ...history.savedQueries,
        ...backup.savedQueries.filter((q) => !history.savedQueries.some((e) => e.id === q.id)),
      ]
    : backup.savedQueries;
  history.savedPipelines = options.merge
    ? [
        ...history.savedPipelines,
        ...backup.savedPipelines.filter((q) => !history.savedPipelines.some((e) => e.id === q.id)),
      ]
    : backup.savedPipelines;
  await writeFileAtomic(paths.historyFile, `${JSON.stringify(history, null, 2)}\n`);
  return {
    connections: backup.connections.profiles.length,
    savedQueries: backup.savedQueries.length,
    savedPipelines: backup.savedPipelines.length,
  };
}
