# Changelog

All notable changes to this project are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-11-04

### Added

- **Copy / migrate**: copy all or selected collections from one database to another, on the same
  server or into another saved connection, or every database at once. Keeps BSON types and
  recreates collection options, views and indexes; duplicates stop, skip or replace; optional drop
  of target collections. Dashboard: `C` on a database in the tree or Main menu → Copy / Migrate.
  CLI: `mtp copy`.
- **Export all databases** (`mtp export --all-databases`, Export → Scope → ALL databases, `X`).
- **Folder import** for one database or every database (`mtp import --dir`, Import → "Import a
  folder…", `I`), validating every file before writing.
- Tree shortcuts on a database: `C` copy, `x` export, `X` export all, `I` import folder.

## [1.1.0] - 2026-11-04

### Added

- Compass / NoSQLBooster-style **workspace** after connecting: database tree on the left (lazy
  collection loading, filter across databases, refresh) and a tabbed collection pane on the right
  (Documents, Aggregations, Query, Indexes, Schema & Stats, Import, Export). Tabs switch with
  Alt+1…7, Alt+←/→ or `[` `]`.
- **Connections home** as the start screen: connection table, details panel, quick actions and a
  welcome chooser when no connection exists yet.
- **Pick-or-type** database and collection fields in Import, Export, Query and Backup/Restore:
  existing names are listed and filtered as you type; new names are marked.
- "Made by Vairag Kakadiya" in the header, home screen, help, CLI help and package metadata.

### Changed

- Panel titles truncate before right-hand status text; narrow document lists show fields instead
  of the `_id`; side-by-side layouts are used from ~90 columns inside the workspace.
- The main menu is now opened with `m` from the connections home or the workspace (Esc goes back).

### Fixed

- Views are no longer offered as import targets.

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
