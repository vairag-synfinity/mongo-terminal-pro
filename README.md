# Mongo Terminal Pro

**A professional, keyboard-first MongoDB manager that runs entirely in your terminal.**
Made by **Vairag Kakadiya**.
Browse databases and documents, run queries and aggregation pipelines, manage indexes, import and
export data, and back up and restore — on Windows, macOS and Linux, locally or over SSH.

```
◆ MONGO TERMINAL PRO by Vairag Kakadiya                       ● Local  MongoDB 7.0 · replica-set
Connections › Local › shop › users                                                    READ-ONLY
──────────────────────────────────────────────────────────────────────────────────────────────────
╭──────────────────────╮ 1 Docs  2 Agg  3 Query  4 Idx  5 Schema  6 Imp  7 Exp   Alt+1-7 or [ ]
│ ● Local              │Filter: { status: "active" }
│ ▾ shop               │╭────────────────────────────────────╮╭─────────────────────────────────╮
│    ▤ orders          ││ shop.users   1-20 of ~1,666 · 1/84 ││ Preview                         │
│    ▤ users           ││ ❯ name: "Ada"  age: 36  city: …    ││ ▾ {                             │
│    ◇ activeUsers     ││   name: "Linus"  age: 54  city: …  ││     _id: ObjectId('65a0…01'),   │
│ ▸ analytics          ││   …                                ││     name: "Ada",                │
╰──────────────────────╯╰────────────────────────────────────╯╰─────────────────────────────────╯
←→ page │ Enter view │ f filter │ i insert │ e edit │ d delete │ c copy │ Alt+1-7 tabs │ Esc sidebar
```

- npm package: `mongo-terminal-pro`
- Commands: `mongo-terminal`, `mtp` (short alias), `mongo-terminal-pro`
- Requires Node.js **22.12+** (current LTS lines 22 and 24)

---

## Contents

- [Features](#features)
- [Installation](#installation)
- [Supported operating systems and terminals](#supported-operating-systems-and-terminals)
- [Quick start](#quick-start)
- [Connections](#connections) — manual, MongoDB Compass discovery, `.env` discovery, saved connections
- [The interactive UI](#the-interactive-ui)
- [Import and export](#import-and-export)
- [Copy, migrate, whole-database import/export](#copy-migrate-and-whole-database-importexport)
- [Backup and restore](#backup-and-restore)
- [Security model](#security-model)
- [CLI commands](#cli-commands)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)
- [Development](#development) and [publishing](#publishing-to-npm)

Detailed guides live in [`docs/`](docs): [installation](docs/installation.md),
[connections](docs/connection-guide.md), [import/export](docs/import-export.md),
[commands](docs/commands.md), [security](docs/security.md), [troubleshooting](docs/troubleshooting.md).

---

## Features

| Area                    | What you get                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Connections**         | Manual form (URI or host/port), Atlas (`mongodb+srv`), replica sets, sharded clusters, TLS/CA/client certificates, X.509/AWS/OIDC/Kerberos mechanisms, connection test before saving, favorites, default connection, rename/edit/delete, recent connections                                                                                    |
| **Discovery**           | Read-only import of **MongoDB Compass** saved connections (Windows/macOS/Linux, snap and Flatpak), Compass export files, and `MONGODB_URI`-style variables from a project's `.env*` files or the current environment                                                                                                                           |
| **Database explorer**   | Accessible databases with collections, documents (estimated), data/storage/index sizes; search, sort, create and drop (with typed confirmation)                                                                                                                                                                                                |
| **Collection explorer** | Collections, views, time-series and capped collections with counts (estimated vs exact), storage, index counts; search, sort, type filter; create/drop                                                                                                                                                                                         |
| **Documents**           | Paginated browser (20 per page by default, configurable), keyset pagination on `_id`, filter/sort/projection, JSON tree with syntax highlighting and expand/collapse, ObjectId/Date/Decimal128/Long/Binary/UUID formatting, insert, edit (built-in editor or `$EDITOR`), duplicate, delete, copy to clipboard (native tool or OSC 52 over SSH) |
| **Query builder**       | `find`, `findOne`, `count`, `distinct`, `updateOne`, `updateMany`, `deleteOne`, `deleteMany`; shell syntax (`ObjectId()`, `ISODate()`, `/regex/`), validation before execution, affected-document preview, history, saved queries, timeouts and result caps                                                                                    |
| **Aggregation**         | Stage builder with templates for `$match $project $group $sort $limit $skip $lookup $unwind $addFields $set $count $facet $bucket $replaceRoot` and more; add/edit/remove/reorder/toggle; per-stage validation; JSON view; duration and document count; saved pipelines; `$out`/`$merge` guarded                                               |
| **Indexes**             | Name, fields, type (single, compound, text, geo, hashed, wildcard, TTL), unique, sparse, TTL, partial filters, size, usage via `$indexStats`; create and drop with warnings (never automatic)                                                                                                                                                  |
| **Import**              | JSON arrays, JSON Lines, Extended JSON, CSV (field mapping and types), BSON (mongodump files), gzip; streaming with bounded batches; validate-everything-first; insert or upsert; abort or skip duplicates; ordered/unordered; dry run; progress; summary and JSONL error report                                                               |
| **Export**              | Collection, query results, selected documents or whole database; JSON (relaxed/canonical Extended JSON or plain JSON), JSON Lines, CSV (field selection, nested fields), BSON (raw, lossless); streaming; progress; file size and location                                                                                                     |
| **Backup / restore**    | Official `mongodump`/`mongorestore` (directory or archive, gzip); verification of every dump; history; restore with namespace collision report, rename, dry run and explicit `--drop`                                                                                                                                                          |
| **Monitoring**          | Connection status, server version, topology, replica-set members and lag, `serverStatus` (connections, memory, network, ops/s), database statistics, pool configuration; manual or configurable refresh                                                                                                                                        |
| **Safety**              | Read-only by default, explicit write access, production connections, locked read-only profiles, confirmations, query safeguards, secret masking everywhere                                                                                                                                                                                     |
| **Terminal UI**         | Dark/light themes, no-colour mode, Unicode with ASCII fallback, responsive layouts, mouse wheel (opt-in), works over SSH                                                                                                                                                                                                                       |

Nothing in the UI is a placeholder: every menu entry is wired to its implementation. Features that
depend on something external (Database Tools, `serverStatus` privileges, a clipboard tool) say so
when it is missing.

---

## Installation

```bash
npm install -g mongo-terminal-pro     # then: mongo-terminal   or   mtp
# or run without installing
npx mongo-terminal-pro
```

**Windows (PowerShell / CMD / Windows Terminal)**

```powershell
winget install OpenJS.NodeJS.LTS          # if Node.js is not installed
npm install -g mongo-terminal-pro
mtp
winget install MongoDB.DatabaseTools      # optional: backup / restore
```

**macOS**

```bash
brew install node
npm install -g mongo-terminal-pro
mtp
brew tap mongodb/brew && brew install mongodb-database-tools   # optional
```

**Ubuntu / Debian**

```bash
# Node.js 22+ (e.g. from NodeSource or nvm)
npm install -g mongo-terminal-pro
mtp
sudo apt-get install mongodb-database-tools   # optional, after adding the MongoDB apt repository
```

See [docs/installation.md](docs/installation.md) for nvm, permissions and offline installs.

---

## Supported operating systems and terminals

| OS              | Terminals                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10 / 11 | Windows Terminal, PowerShell, CMD (classic console uses ASCII symbols automatically), VS Code                                               |
| macOS           | Terminal.app, iTerm2, VS Code                                                                                                               |
| Linux           | Ubuntu, Debian, Fedora and other distributions; GNOME Terminal, Konsole, xterm, Alacritty, kitty, tmux/screen, the Linux VT console (ASCII) |
| Remote          | SSH sessions (clipboard via OSC 52, keyring falls back to an encrypted file on headless servers)                                            |

Capabilities are detected at start-up: colour depth (honours `NO_COLOR`/`FORCE_COLOR`), Unicode
support, terminal size (layouts adapt on resize; below 40×12 a resize hint is shown) and TTY. Force
modes with `--no-color`, `--ascii`, `--unicode`, `--theme light`. Everything works with the
keyboard alone; mouse wheel scrolling is opt-in (`--mouse` or Settings).

---

## Quick start

```bash
mtp                                   # open the dashboard
# a  New connection → fill the form → Test Connection → Save → Enter (connect)
# workspace opens: pick a database in the tree → → expand → Enter on a collection → Documents tab
```

Or from the shell:

```bash
mtp connections add                   # interactive; the password is prompted, never an argument
mtp databases
mtp collections --db shop
mtp query --db shop --collection users --filter '{ age: { $gte: 18 } }' --limit 5
```

---

## Connections

### Manual connection

Connection Manager → `a`. Use either a connection string or host/port fields:

| Field                                  | Notes                                                                                           |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Connection name                        | Unique, shown everywhere                                                                        |
| Connection type                        | local, atlas, self-hosted, replica-set, sharded (detected from the URI)                         |
| Connection URI                         | `mongodb://` or `mongodb+srv://`. A password in the URI is **moved** to secure storage          |
| Host(s) / Port / +srv / Replica set    | Alternative to the URI; comma-separate replica set members                                      |
| Username / Password                    | Password stored in the OS keychain when "Remember password" is on                               |
| Auth database / mechanism              | `authSource` (usually `admin`), SCRAM, X.509, AWS, OIDC, GSSAPI, PLAIN                          |
| Default database                       | Used when your user cannot list databases                                                       |
| TLS / CA file / client cert            | `default` follows the URI (`+srv` implies TLS). "Allow invalid certs" is for local testing only |
| Timeout                                | Server selection / connect timeout                                                              |
| Production / Lock read-only / Favorite | See [Security model](#security-model)                                                           |

**Test Connection** pings the server and shows version and topology without saving. **SSH
tunnels** are supported through standard SSH port forwarding — see
[docs/connection-guide.md](docs/connection-guide.md#ssh-tunnels).

### MongoDB Compass discovery

Connection Manager → `c` (or `mtp connections discover --compass`). Mongo Terminal Pro looks in the
Compass configuration directories:

| OS      | Location                                                           |
| ------- | ------------------------------------------------------------------ |
| Windows | `%APPDATA%\MongoDB Compass\Connections\*.json`                     |
| macOS   | `~/Library/Application Support/MongoDB Compass/Connections/*.json` |
| Linux   | `~/.config/MongoDB Compass/…` (also snap and Flatpak locations)    |

Readonly, Isolated and Beta editions are included. Files are opened **read-only and never
modified**. Compass 1.39+ stores passwords encrypted with the operating system (Electron
safeStorage / keychain / DPAPI); Mongo Terminal Pro does **not** try to decrypt them — you are asked
for the password the first time you connect. Older Compass versions that keep connections in an
internal database can be imported from a Compass export file:
`mtp connections discover --compass-export connections.json`.

### Project environment variables

Connection Manager → `v` (or `mtp connections discover --dir ./my-project`). With your explicit
consent, the `.env`, `.env.local`, `.env.development`, `.env.test`, `.env.production` (and
`*.local`) files **of that one directory** are read — never recursively, and no project code is
executed. Recognised variables include `MONGODB_URI`, `MONGO_URI`, `MONGODB_URL`, `MONGO_URL` and
`DATABASE_URL` (only when it is a MongoDB URI). Values are masked on screen; passwords found can be
stored in secure storage if you choose.

### Saved connections

Enter connect · `a` add · `e` edit · `d` delete · `r` rename · `t` test · `f` favorite · `s` set
default · `x` disconnect. CLI equivalents: `mtp connections list|add|remove|rename|default|favorite|test`.

---

## The interactive UI

The layout follows MongoDB Compass and NoSQLBooster:

1. **Connections home** (start screen): every saved connection in a table with details, plus
   quick actions — `a` new connection, `c` import from Compass, `v` from `.env`, `m` main menu,
   `,` settings. Enter connects (or reopens the workspace of the active connection).
2. **Workspace** (after connecting):
   - **Left — database tree**: databases with their collections (`▤` collection, `◇` view).
     `↑↓` move · `→`/Enter expand or open · `←` collapse · `/` filter (also finds collections in
     databases you have not expanded) · `r` refresh · Tab to the pane · Esc back to connections.
   - **Right — pane**: no selection shows all databases with statistics; a database shows its
     collections (create/drop, sizes, index counts); a collection opens **tabs**:
     `1 Documents` · `2 Aggregations` · `3 Query` · `4 Indexes` · `5 Schema & Stats` · `6 Import` ·
     `7 Export`. Switch with **Alt+1…7** (works while typing), Alt+←/→, or `[` `]`.
     Esc returns to the tree.
   - From the tree: `m` main menu (all tools), `b` backup/restore, `S` server statistics,
     `,` settings.
3. **Pick or type**: database and collection fields (Import, Export, Query, Backup) list the
   existing names — type to filter, `↓` to choose, Enter to accept — or type a new name, which is
   marked `+ new`.

Global keys: `?` help · `W` toggle write access · `Ctrl+C`/`Q` quit · `Ctrl+X` dismiss notifications.
Narrow terminals (< 90 columns) show the tree and the pane one at a time.

**Documents tab:** `←→` page · Enter tree view · `f` filter · `s` sort · `o` projection · `z` page size ·
`i` insert · `e` edit · `E` edit in `$EDITOR` · `u` duplicate · `d` delete · `c` copy · `x` export
results · `r` refresh. Editors accept shell syntax and validate before saving (`Ctrl+S`).

**Query tab:** Tab between fields, `Ctrl+R` run. Destructive operations show how many documents
will be affected and require confirmation (typing the connection name for production, or for
`updateMany`/`deleteMany` with an empty filter).

**Aggregations tab:** `a` add stage from templates, Enter edit, `x` remove, `K`/`J` reorder, Space
enable/disable, `v` pipeline JSON, `p` paste a pipeline, `s` save, `l` load, `Ctrl+R` run.

The classic **main menu** (`m`) still offers every tool in one list.

## Import and export

```bash
# Export a collection (relaxed Extended JSON array)
mtp export --db shop --collection users --format json --out users.json
# Filtered, sorted CSV with selected (nested) fields
mtp export --db shop --collection users --format csv --fields name,email,address.city \
  --filter '{ status: "active" }' --sort '{ createdAt: -1 }' --out active.csv
# Lossless BSON / canonical Extended JSON / entire database (one file per collection)
mtp export --db shop --collection users --format bson --out users.bson
mtp export --db shop --collection users --json-mode canonical --layout jsonl --out users.jsonl
mtp export --db shop --format json --out ./shop-export/

# Import (sessions are read-only: --write is required)
mtp import --db shop --collection users --file users.json --dry-run
mtp import --db shop --collection users --file users.json --write
mtp import --db shop --collection users --file users.csv --write --duplicates skip --batch-size 2000
mtp import --db shop --collection users --file users.jsonl --write --mode upsert --upsert-fields email
```

**Extended JSON vs plain JSON** (`mtp export --explain-json`):

- **Relaxed Extended JSON** (default): readable; ObjectId, Date, Decimal128 and Binary keep
  `{"$oid": …}`-style wrappers; numbers are plain JSON numbers (int/long/double are not
  distinguished), and longs beyond 2^53 stay `{"$numberLong": …}` so no precision is lost.
- **Canonical Extended JSON**: fully lossless — every number is annotated. Best for exact round trips.
- **Plain JSON**: ordinary JSON for other tools; ObjectIds and dates become strings — type
  information is lost.
- **BSON** export streams the server's raw bytes and is always lossless.

Imports validate the entire file before writing anything (disable with `--no-validate-first`),
stream files in bounded batches (large files never sit in memory), never overwrite existing
documents in insert mode, and write an error report with `--error-report errors.jsonl`. Details:
[docs/import-export.md](docs/import-export.md).

---

## Copy, migrate, and whole-database import/export

| Task                                                            | Dashboard (workspace tree, on a database) | CLI                                                             |
| --------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| Copy a database (all or chosen collections) to another database | `C` → Copy / migrate                      | `mtp copy --from-db shop --to-db shop_copy --write`             |
| Migrate a database to another server / connection               | `C` → Target connection                   | `mtp copy --from-db shop --to-connection Atlas --write`         |
| Migrate **all databases** to another connection                 | `C` → What to copy: ALL databases         | `mtp copy --all-databases --to-connection "New server" --write` |
| Export one database (file per collection)                       | `x`                                       | `mtp export --db shop --out ./shop/`                            |
| Export **all databases** (folder per database)                  | `X`                                       | `mtp export --all-databases --out ./all/`                       |
| Import a folder into one database                               | `I`                                       | `mtp import --dir ./shop/ --db shop --write`                    |
| Import an export-all folder (every database)                    | `I` → one sub-folder per database         | `mtp import --dir ./all/ --all-databases --write`               |

Copying streams documents in batches, keeps exact BSON types, and recreates collection options
(capped, validators, collation, time series), views and indexes. Existing target documents are
never overwritten unless you choose it: by default the copy stops at the first `_id` that already
exists (`--duplicates skip` skips them, `--duplicates replace` replaces them, `--drop` drops target
collections first). Writing into another connection asks for confirmation — typing its name when it
is production or the operation is destructive (`--confirm "<name>"` in scripts). Folder imports
validate every file before writing anything. For a byte-exact server copy you can still use
**Backup / Restore** (mongodump / mongorestore).

## Backup and restore

Requires the official [MongoDB Database Tools](https://www.mongodb.com/try/download/database-tools)
(`mtp tools` checks them and prints OS-specific install instructions).

```bash
mtp backup --db shop --gzip                         # verified directory backup
mtp backup --db shop --collection users --archive --gzip
mtp backups                                         # history
mtp restore --path ~/…/backups/Local/2026-…_shop --dry-run
mtp restore --path ~/…/backups/Local/2026-…_shop --from-db shop --to-db shop_copy --write
mtp restore --path ./dump --write --drop            # replaces existing collections (asks first)
```

A backup is reported successful only when `mongodump` exits with code 0 **and** verification passes:
every `.bson` file is parsed end to end (gzip CRC included), metadata files are present, and
document counts match what `mongodump` reported. Archives are checked for the archive magic number
and gzip integrity. Restores show a namespace collision report first; `--drop` is never implied.
Credentials are passed to the tools through a temporary private `--config` file — never on the
command line.

---

## Security model

- **Read-only by default.** Every session starts read-only. Writes need `W` in the dashboard or
  `--write` on the CLI. Switching connections drops back to read-only.
- **Production connections** require typing the connection name to enable writes and to confirm
  destructive operations (`--confirm "<name>"` for non-interactive use).
- **Locked read-only** connections can never enable writes.
- **Destructive operations** (delete, drop, `updateMany`/`deleteMany`, upsert imports, `$out`/`$merge`,
  index drops, restores) always ask for confirmation and show what is affected.
- **Credentials** live in the OS credential store (Windows Credential Manager, macOS Keychain,
  Secret Service on Linux). Fallback: an AES-256-GCM encrypted file, keyed by `MTP_MASTER_PASSWORD`
  (scrypt) or a local 0600 key file. Or choose "none" to be asked every session. Profiles never
  contain passwords.
- **No secrets on the command line**: passwords are never accepted as arguments (they would appear
  in shell history and process lists). Use saved connections, `MTP_URI`/`MTP_PASSWORD`, or prompts.
- **Masking**: connection strings and secrets are redacted in the UI, errors and logs.
- **Safe subprocesses**: Database Tools are spawned without a shell; arguments are never interpolated.
- **Query safeguards**: `maxTimeMS` on every query and pipeline, result caps, no unbounded reads,
  warnings for `$where` and unbounded pipelines.
- **Export path validation**: no silent overwrites, system directories refused, partial files removed.
- MongoDB permissions are never bypassed; unavailable commands are reported as such.

More in [docs/security.md](docs/security.md).

---

## CLI commands

| Command                                                                              | Purpose                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `mongo-terminal` / `mtp`                                                             | Open the interactive dashboard (`-c <name>` connects immediately)               |
| `mtp connect`                                                                        | Open the connection manager                                                     |
| `mtp connections list\|add\|remove\|rename\|default\|favorite\|test\|discover`       | Manage connections                                                              |
| `mtp status`                                                                         | Connection status and server information                                        |
| `mtp databases`                                                                      | List accessible databases with statistics                                       |
| `mtp collections --db <db>`                                                          | List collections                                                                |
| `mtp query --db <db> --collection <c> --filter '<json>'`                             | Read-only find, printed as Extended JSON                                        |
| `mtp export --db <db> [--collection <c>] --format json\|csv\|bson`                   | Export                                                                          |
| `mtp import --db <db> --collection <c> --file <path> --write`                        | Import                                                                          |
| `mtp copy --from-db <db> [--to-db <db>] [--to-connection <name>] --write`            | Copy / migrate databases and collections (`--all-databases` for every database) |
| `mtp backup --db <db>` / `mtp restore --path <dir\|archive> --write` / `mtp backups` | Backup and restore                                                              |
| `mtp tools` / `mtp doctor`                                                           | Check Database Tools / diagnose terminal, platform and credential storage       |
| `mtp config path\|export <file>\|import <file>`                                      | Configuration location, backup and restore (no secrets)                         |

Global options: `-c, --connection <name>`, `--config-dir <path>`, `--no-color`, `--ascii`,
`--unicode`, `--theme dark|light`, `--mouse`, `--no-log`. Most listing commands accept `--json`.
Full reference: [docs/commands.md](docs/commands.md).

---

## Configuration

Stored in the OS-standard per-user directory (override with `MTP_CONFIG_DIR`):

| OS      | Directory                                                                      |
| ------- | ------------------------------------------------------------------------------ |
| Windows | `%APPDATA%\mongo-terminal-pro`                                                 |
| macOS   | `~/Library/Application Support/mongo-terminal-pro`                             |
| Linux   | `$XDG_CONFIG_HOME/mongo-terminal-pro` (default `~/.config/mongo-terminal-pro`) |

Files: `settings.json`, `connections.json` (no passwords), `history.json` (query history, saved
queries and pipelines), `backup-history.json`, `credentials.enc.json` + `master.key` (only for the
encrypted-file fallback), `logs/`. Backups and exports default to `~/Documents/MongoTerminalPro`
(Windows/macOS) or `~/.local/share/mongo-terminal-pro` (Linux); override with `MTP_DATA_DIR` or in
Settings. `mtp config export backup.json` saves settings, connection profiles and saved queries —
never secrets.

Environment variables: `MTP_CONFIG_DIR`, `MTP_DATA_DIR`, `MTP_URI`, `MTP_PASSWORD`,
`MTP_PRODUCTION=1` (with `MTP_URI`), `MTP_MASTER_PASSWORD`, `MTP_DISABLE_KEYRING=1`,
`MTP_EDITOR`/`VISUAL`/`EDITOR`, `MTP_MONGODUMP_PATH` (and `…MONGORESTORE…`, `…MONGOEXPORT…`,
`…MONGOIMPORT…`), `MTP_ASCII=1`, `NO_COLOR`, `FORCE_COLOR`.

---

## Troubleshooting

| Symptom                                | Fix                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Boxes or arrows look broken (e.g. CMD) | `mtp --ascii` or Settings → Symbols → ascii                                                                 |
| No colours / odd colours               | `--no-color`, `--theme light`, or check `NO_COLOR`/`FORCE_COLOR`                                            |
| "needs an interactive terminal"        | Run in a real terminal; on Git Bash/mintty use `winpty mtp`; use CLI commands in scripts                    |
| Server selection timed out             | Host/port, firewall, VPN, Atlas IP access list, replica set host names                                      |
| Authentication failed                  | Username/password and `authSource` (usually `admin`)                                                        |
| "No usable OS credential store"        | Normal on headless Linux/SSH; the encrypted file is used. Set `MTP_MASTER_PASSWORD` for stronger protection |
| `mongodump` not found                  | `mtp tools` shows install steps; or set `MTP_MONGODUMP_PATH`                                                |
| `serverStatus unavailable`             | Needs the `clusterMonitor` role; the rest of the dashboard still works                                      |

More: [docs/troubleshooting.md](docs/troubleshooting.md). Logs (secrets redacted) are in the `logs/`
folder of the configuration directory.

---

## Limitations

- Passwords stored by MongoDB Compass are encrypted by the OS for Compass only and are intentionally
  not recovered; you enter them once.
- SSH tunnels are not built in; use standard SSH port forwarding (documented).
- Mouse support is limited to wheel scrolling (opt-in); everything else is keyboard driven.
- Values typed into the document editor follow shell rules: a plain `5` becomes a 32-bit integer
  and `5.5` a double; use `NumberLong()`, `Double()` or `NumberDecimal()` for other types. Values you
  do not touch keep their exact BSON types.
- Estimated document counts come from collection metadata; exact counts are opt-in (`x`) and bounded
  by a timeout.
- Monitoring shows what supported commands expose to your user; it is not a full server monitoring
  solution.
- Archive backups are verified for integrity, not per-collection document counts (directory backups
  are fully verified).
- Clipboard over SSH relies on OSC 52 support in your terminal; otherwise documents can be saved to a file.

---

## Development

```bash
git clone <your fork> && cd mongo-terminal-pro
npm install
npm run build          # TypeScript → dist/
npm run typecheck && npm run lint
npm test               # unit + cross-platform; integration suites skip without a database

# Integration tests need a disposable MongoDB (never point them at real data):
docker run -d --name mtp-test -p 127.0.0.1:27099:27099 mongo:7.0 mongod --replSet rs0 --port 27099 --bind_ip_all
docker exec mtp-test mongosh --port 27099 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27099"}]})'
MTP_TEST_MONGODB_URI="mongodb://localhost:27099/?directConnection=true" npm test
```

Integration tests refuse non-local servers unless `MTP_TEST_ALLOW_REMOTE=1`, work only in randomly
named `mtp_it_*` databases and drop them afterwards. The TUI end-to-end tests run the real binary in
a pseudo-terminal (POSIX `script`) and assert on the emulated screen.

Architecture (`src/`): `cli/` (Commander commands), `core/` (application, state, events, errors,
logging), `connection/` (profiles, validation, discovery, driver connection), `database/` (databases,
collections, documents, queries, aggregation, indexes, schema, statistics, monitoring), `transfer/`
(streaming JSON/CSV/BSON import and export), `backup/` (Database Tools, verification, history),
`security/` (credentials, encryption, permissions, redaction), `ui/` (Ink/React screens, components,
layouts, hooks, themes), `config/`, `utils/`.

## Publishing to npm

```bash
npm version patch|minor|major      # semantic versioning; update CHANGELOG.md first
npm run prepublishOnly             # typecheck, lint, unit tests, build
npm pack --dry-run                 # inspect the tarball (dist, docs, README, LICENSE, CHANGELOG)
npm publish                        # publishConfig.access = public
```

## Author

Made by **Vairag Kakadiya**.

## License

[MIT](LICENSE) © 2026 Vairag Kakadiya
