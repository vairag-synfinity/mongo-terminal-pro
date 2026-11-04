# Command reference

`mongo-terminal`, `mtp` and `mongo-terminal-pro` are the same program.

## Global options

| Option                        | Description                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `-c, --connection <name>`     | Saved connection to use (name, case-insensitive, or id). Without it: `MTP_URI`, else the default connection |
| `--config-dir <path>`         | Alternative configuration directory (same as `MTP_CONFIG_DIR`)                                              |
| `--no-color`                  | Disable colours (also `NO_COLOR=1`)                                                                         |
| `--ascii` / `--unicode`       | Force ASCII or Unicode symbols                                                                              |
| `--theme dark\|light`         | Colour theme for this run                                                                                   |
| `--mouse`                     | Enable mouse wheel scrolling in the dashboard                                                               |
| `--no-log`                    | Do not write the log file                                                                                   |
| `-v, --version`, `-h, --help` | Version and help (every sub-command has `--help`)                                                           |

Exit codes: `0` success, `1` error, `2` completed with failures (e.g. import aborted, backup not
verified), `130` cancelled at a prompt.

## Interactive

```bash
mtp                     # dashboard
mtp -c "Local"          # connect to a saved connection and open the dashboard
mtp connect             # open the connection manager
```

## connections

```bash
mtp connections list [--json]
mtp connections add [--name <n>] [--uri <uri-without-password>] [--production] [--save-password] [--no-test]
mtp connections remove <name> [-y]
mtp connections rename <name> <new-name>
mtp connections default <name>
mtp connections favorite <name>
mtp connections test [name]
mtp connections discover --compass | --compass-export <file> | --env | --dir <path> [--all] [--save-passwords]
```

## status, databases, collections, query

```bash
mtp status [--json]
mtp databases [--json] [--no-stats]
mtp collections --db <db> [--search <text>] [--json]
mtp query --db <db> --collection <c> [--filter '<json>'] [--projection '<json>'] [--sort '<json>'] [--limit 20] [--skip 0]
```

`query` is read-only and prints Extended JSON (relaxed) to stdout; the summary goes to stderr, so
`mtp query … > out.json` works. Filters accept shell syntax:
`--filter '{ _id: ObjectId("…"), at: { $gte: ISODate("2024-01-01") } }'`.

## export

```bash
mtp export (--db <db> [--collection <c>] | --all-databases) [--format json|csv|bson] [--out <file|dir>]
           [--filter '<json>'] [--sort '<json>'] [--fields a,b.c] [--limit <n>]
           [--json-mode relaxed|canonical|plain] [--layout array|jsonl] [--batch-size <n>]
           [--overwrite] [--engine builtin|tools] [--explain-json]
```

Omit `--collection` to export every collection of the database into the `--out` directory.

## import

```bash
mtp import --dir <folder> (--db <db> | --all-databases) --write [--mode ...] [--skip-invalid] [--dry-run]
mtp import --db <db> --collection <c> --file <path> --write
           [--format json|csv|bson] [--mode insert|upsert] [--upsert-fields a,b]
           [--duplicates abort|skip] [--batch-size <n>] [--unordered] [--skip-invalid]
           [--no-validate-first] [--dry-run] [--delimiter <c>] [--error-report <file>]
           [--confirm <connection-name>] [-y] [--engine builtin|tools]
```

`--write` is required unless `--dry-run` is given. For production connections pass
`--confirm "<connection name>"` (or answer the prompt).

## copy

```bash
mtp copy --from-db <db> [--to-db <db>] [--collections a,b] [--to-connection <name>]
         [--duplicates abort|skip|replace] [--drop] [--no-indexes] [--no-views] [--batch-size <n>]
         --write [--confirm <name>] [-y]
mtp copy --all-databases --to-connection <name> --write [...]
```

Copies from the active connection (`-c`). On the same connection `--to-db` is required. Writing into
another connection asks for confirmation; non-interactively pass `-y`, or `--confirm "<target
name>"` when the target is production or the copy is destructive (`--drop`, `--duplicates replace`).
`MTP_TARGET_PASSWORD` supplies the target password when it is not stored.

## backup, restore, backups, tools

```bash
mtp backup [--db <db>] [--collection <c>] [--gzip] [--archive] [--out <dir>]
mtp restore --path <dir|archive> [--from-db <db> --to-db <db>] [--ns-include <pattern...>]
            [--drop] [--dry-run] --write [--confirm <name>] [-y]
mtp backups [--json]
mtp tools
```

## doctor and config

```bash
mtp doctor                   # platform, terminal, colours, Unicode, paths, credential storage, tools
mtp config path              # JSON with all file locations
mtp config export <file>     # settings + connection profiles (no passwords) + saved queries/pipelines
mtp config import <file> [--merge] [-y]
```

## Environment variables

| Variable                                                                                      | Purpose                                                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `MTP_CONFIG_DIR` / `MTP_DATA_DIR`                                                             | Configuration and data (backups/exports) directories         |
| `MTP_URI`, `MTP_PASSWORD`, `MTP_PRODUCTION=1`                                                 | Ad-hoc connection for CLI commands (not saved)               |
| `MTP_MASTER_PASSWORD`                                                                         | Passphrase protecting the encrypted credential file fallback |
| `MTP_DISABLE_KEYRING=1`                                                                       | Do not use the OS credential store                           |
| `MTP_EDITOR`, `VISUAL`, `EDITOR`                                                              | External editor for documents (`E` in the document browser)  |
| `MTP_MONGODUMP_PATH`, `MTP_MONGORESTORE_PATH`, `MTP_MONGOEXPORT_PATH`, `MTP_MONGOIMPORT_PATH` | Database Tools locations                                     |
| `MTP_ASCII=1`, `MTP_UNICODE=1`, `NO_COLOR`, `FORCE_COLOR`                                     | Terminal rendering                                           |
