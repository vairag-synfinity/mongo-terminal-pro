import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JsonStore } from '../config/json-store.js';
import type { AppPaths } from '../config/paths.js';

export const BackupRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(['backup', 'restore']),
  createdAt: z.string(),
  connectionId: z.string().optional(),
  connectionName: z.string(),
  database: z.string().optional(),
  collection: z.string().optional(),
  path: z.string(),
  layout: z.enum(['directory', 'archive']),
  gzip: z.boolean(),
  status: z.enum(['success', 'failed', 'verification-failed', 'cancelled']),
  verified: z.boolean().default(false),
  verificationSummary: z.string().optional(),
  documents: z.number().optional(),
  sizeBytes: z.number().optional(),
  durationMs: z.number(),
  toolVersion: z.string().optional(),
  error: z.string().optional(),
});
export type BackupRecord = z.infer<typeof BackupRecordSchema>;

const BackupHistoryFileSchema = z.object({
  version: z.literal(1).default(1),
  records: z.array(BackupRecordSchema).default([]),
});

export class BackupHistory {
  private readonly store;

  constructor(paths: AppPaths) {
    this.store = new JsonStore(paths.backupHistoryFile, BackupHistoryFileSchema, () =>
      BackupHistoryFileSchema.parse({}),
    );
  }

  async add(record: Omit<BackupRecord, 'id' | 'createdAt'>): Promise<BackupRecord> {
    const full: BackupRecord = { ...record, id: randomUUID(), createdAt: new Date().toISOString() };
    await this.store.update((f) => {
      f.records = [full, ...f.records].slice(0, 500);
    });
    return full;
  }

  async list(): Promise<BackupRecord[]> {
    return (await this.store.read()).records;
  }

  async remove(id: string): Promise<void> {
    await this.store.update((f) => {
      f.records = f.records.filter((r) => r.id !== id);
    });
  }
}
