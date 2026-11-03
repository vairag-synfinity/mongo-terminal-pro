/**
 * Programmatic API of mongo-terminal-pro. The CLI (`mongo-terminal` / `mtp`) is built on these
 * modules; they can also be used directly from Node.js scripts.
 */
export { Application } from './core/application.js';
export { AppError, ReadOnlyError, ValidationError, toFriendlyError } from './core/error-handler.js';
export { getAppPaths, resolveConfigDir } from './config/paths.js';
export { DEFAULT_SETTINGS, SettingsSchema, type Settings } from './config/defaults.js';
export { ConnectionManager, buildClientOptions } from './connection/connection-manager.js';
export { ConnectionStorage } from './connection/connection-storage.js';
export { discoverCompassConnections, parseCompassConnection } from './connection/compass-discovery.js';
export { collectFromProjectDirectory, parseDotEnv } from './connection/env-discovery.js';
export { buildConnectionFromDraft, stripCredentials } from './connection/manual-connection.js';
export { validateDraft, validateUri } from './connection/connection-validator.js';
export {
  ConnectionProfileSchema,
  type ConnectionDraft,
  type ConnectionProfile,
  type ServerInfo,
} from './connection/connection-types.js';
export { DatabaseServices } from './database/database-services.js';
export { parseQuery } from './database/query-manager.js';
export { validatePipeline } from './database/aggregation-manager.js';
export { analyzeDocuments } from './database/schema-analyzer.js';
export { ImportManager, type ImportOptions, type ImportSummary } from './transfer/import-manager.js';
export { ExportManager, type ExportOptions, type ExportSummary } from './transfer/export-manager.js';
export { BackupManager } from './backup/backup-manager.js';
export { RestoreManager, inspectBackup } from './backup/restore-manager.js';
export { verifyArchiveBackup, verifyDirectoryBackup } from './backup/backup-validator.js';
export { PermissionManager, Operations } from './security/permission-manager.js';
export { CredentialManager } from './security/credential-manager.js';
export { maskConnectionString, redactText } from './security/sensitive-data-filter.js';
export { parseMongoValue, parseMongoObject, validateDocument } from './utils/validation.js';
