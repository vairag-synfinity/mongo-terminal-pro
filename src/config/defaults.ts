import { z } from 'zod';

export const ThemeNameSchema = z.enum(['dark', 'light']);
export type ThemeName = z.infer<typeof ThemeNameSchema>;

export const SettingsSchema = z.object({
  theme: ThemeNameSchema.default('dark'),
  colorMode: z.enum(['auto', 'color', 'no-color']).default('auto'),
  unicodeMode: z.enum(['auto', 'unicode', 'ascii']).default('auto'),
  /** Opt-in: SGR mouse reporting (wheel scrolling). Disabled by default because it interferes with text selection. */
  mouse: z.boolean().default(false),
  pageSize: z.number().int().min(1).max(500).default(20),
  queryTimeoutMs: z.number().int().min(100).max(3_600_000).default(30_000),
  queryResultLimit: z.number().int().min(1).max(100_000).default(1_000),
  aggregationTimeoutMs: z.number().int().min(100).max(3_600_000).default(60_000),
  aggregationResultLimit: z.number().int().min(1).max(100_000).default(500),
  aggregationAllowDiskUse: z.boolean().default(false),
  connectTimeoutMs: z.number().int().min(500).max(120_000).default(10_000),
  maxPoolSize: z.number().int().min(1).max(500).default(10),
  /** 0 disables automatic refresh on the monitoring screen. */
  monitoringRefreshSeconds: z.number().int().min(0).max(3600).default(0),
  importBatchSize: z.number().int().min(1).max(100_000).default(1_000),
  exportBatchSize: z.number().int().min(1).max(100_000).default(1_000),
  schemaSampleSize: z.number().int().min(1).max(10_000).default(200),
  exactCountTimeoutMs: z.number().int().min(100).max(600_000).default(5_000),
  historyLimit: z.number().int().min(0).max(5_000).default(200),
  credentialStorage: z.enum(['auto', 'keyring', 'encrypted-file', 'none']).default('auto'),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  defaultExportDir: z.string().optional(),
  defaultBackupDir: z.string().optional(),
  lastImportFormat: z.enum(['json', 'csv', 'bson']).optional(),
  lastExportFormat: z.enum(['json', 'csv', 'bson']).optional(),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

/** Settings that can be edited from the settings screen, with display metadata. */
export interface SettingDescriptor {
  key: keyof Settings;
  label: string;
  description: string;
  kind: 'enum' | 'number' | 'boolean' | 'string';
  options?: readonly string[];
}

export const SETTING_DESCRIPTORS: SettingDescriptor[] = [
  { key: 'theme', label: 'Theme', description: 'Colour palette', kind: 'enum', options: ['dark', 'light'] },
  {
    key: 'colorMode',
    label: 'Colour mode',
    description: 'auto respects NO_COLOR/FORCE_COLOR',
    kind: 'enum',
    options: ['auto', 'color', 'no-color'],
  },
  {
    key: 'unicodeMode',
    label: 'Symbols',
    description: 'Unicode box drawing or ASCII fallback',
    kind: 'enum',
    options: ['auto', 'unicode', 'ascii'],
  },
  {
    key: 'mouse',
    label: 'Mouse wheel',
    description: 'Enable mouse wheel scrolling (opt-in)',
    kind: 'boolean',
  },
  { key: 'pageSize', label: 'Page size', description: 'Documents per page (1-500)', kind: 'number' },
  {
    key: 'queryTimeoutMs',
    label: 'Query timeout (ms)',
    description: 'maxTimeMS for queries',
    kind: 'number',
  },
  {
    key: 'queryResultLimit',
    label: 'Query result limit',
    description: 'Max documents returned',
    kind: 'number',
  },
  {
    key: 'aggregationTimeoutMs',
    label: 'Aggregation timeout (ms)',
    description: 'maxTimeMS for pipelines',
    kind: 'number',
  },
  {
    key: 'aggregationResultLimit',
    label: 'Aggregation result limit',
    description: 'Max documents returned',
    kind: 'number',
  },
  {
    key: 'aggregationAllowDiskUse',
    label: 'Aggregation allowDiskUse',
    description: 'Allow pipelines to spill to disk',
    kind: 'boolean',
  },
  {
    key: 'connectTimeoutMs',
    label: 'Connect timeout (ms)',
    description: 'Server selection timeout',
    kind: 'number',
  },
  { key: 'maxPoolSize', label: 'Max pool size', description: 'Driver connection pool size', kind: 'number' },
  {
    key: 'monitoringRefreshSeconds',
    label: 'Monitor refresh (s)',
    description: '0 = manual refresh only',
    kind: 'number',
  },
  {
    key: 'importBatchSize',
    label: 'Import batch size',
    description: 'Documents per write batch',
    kind: 'number',
  },
  { key: 'exportBatchSize', label: 'Export batch size', description: 'Cursor batch size', kind: 'number' },
  { key: 'schemaSampleSize', label: 'Schema sample size', description: 'Documents sampled', kind: 'number' },
  {
    key: 'exactCountTimeoutMs',
    label: 'Exact count timeout (ms)',
    description: 'Time limit for countDocuments',
    kind: 'number',
  },
  { key: 'historyLimit', label: 'History limit', description: 'Query history entries kept', kind: 'number' },
  {
    key: 'credentialStorage',
    label: 'Credential storage',
    description: 'auto = OS keychain, else encrypted file',
    kind: 'enum',
    options: ['auto', 'keyring', 'encrypted-file', 'none'],
  },
  {
    key: 'logLevel',
    label: 'Log level',
    description: 'File log verbosity (secrets are always redacted)',
    kind: 'enum',
    options: ['error', 'warn', 'info', 'debug', 'silent'],
  },
  {
    key: 'defaultExportDir',
    label: 'Default export dir',
    description: 'Blank = data directory',
    kind: 'string',
  },
  {
    key: 'defaultBackupDir',
    label: 'Default backup dir',
    description: 'Blank = data directory',
    kind: 'string',
  },
];
