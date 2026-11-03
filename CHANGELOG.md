# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-11-03

### Added

- Interactive full-screen terminal dashboard (Ink/React) with dark and light themes, no-colour mode,
  Unicode and ASCII rendering, responsive layouts, breadcrumbs, notifications, confirmation dialogs,
  progress bars, searchable lists and opt-in mouse wheel scrolling.
- Connection manager: manual connections (URI or fields, TLS, replica sets, SRV, auth mechanisms),
  connection testing, saved profiles with favorites, default and recent connections.
- Read-only MongoDB Compass discovery for Windows, macOS and Linux (including Readonly/Isolated/Beta
  editions, snap and Flatpak) and Compass export files; `.env` / environment variable discovery.
- Secure credential storage in the OS keychain with an AES-256-GCM encrypted-file fallback.
- Database and collection explorers with metadata-based statistics, search, sort, filters,
  create/drop.
- Document browser with keyset pagination, JSON tree view, shell-syntax editor, `$EDITOR` support,
  insert/edit/duplicate/delete and clipboard copy.
- Query builder (find, findOne, count, distinct, update*, delete*) with validation, previews,
  history and saved queries.
- Aggregation pipeline builder with stage templates, validation, reordering and saved pipelines.
- Index management with usage statistics.
- Streaming import (JSON, JSON Lines, Extended JSON, CSV with mapping, BSON, gzip) and export (JSON
  relaxed/canonical/plain, JSON Lines, CSV, raw BSON; collections, query results, selected
  documents, whole databases).
- Backup and restore through mongodump/mongorestore with verification and history; optional
  mongoexport/mongoimport engine.
- Monitoring dashboard (server, replica set, serverStatus, pool, database statistics).
- CLI commands: connect, connections, status, databases, collections, query, export, import,
  backup, restore, backups, tools, doctor, config.
- Read-only-by-default permission model, production and locked connections, secret redaction.
