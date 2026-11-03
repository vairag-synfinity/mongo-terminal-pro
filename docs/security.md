# Security

## Access model

| Rule                   | Details                                                                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only by default   | Every new session and every connection switch starts read-only. Services enforce this themselves, not only the UI.                                                                                                                                             |
| Explicit write access  | Dashboard: `W` (confirmation dialog). CLI: `--write` on `import` / `restore`.                                                                                                                                                                                  |
| Production connections | Mark a profile as _Production_: enabling writes and destructive operations require typing the connection name.                                                                                                                                                 |
| Locked read-only       | Profiles with _Lock read-only_ can never enable writes.                                                                                                                                                                                                        |
| Destructive operations | Delete document, `updateMany`, `deleteMany`, drop collection/database/index, upsert import, `$out`/`$merge`, restore (and restore `--drop`) always ask for confirmation and show what is affected. Dropping a database or collection requires typing its name. |
| Server permissions     | Never bypassed. Missing privileges are reported as "not authorised".                                                                                                                                                                                           |

## Credentials

Profiles (`connections.json`) never contain passwords: a password in a URI is removed and stored
separately. Storage backends (Settings → Credential storage):

| Setting          | Backend                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto` (default) | OS credential store via `@napi-rs/keyring` — Windows Credential Manager, macOS Keychain, Linux Secret Service. If unavailable (headless Linux, SSH without a keyring), the encrypted file. |
| `keyring`        | Same, but the fallback is announced explicitly                                                                                                                                             |
| `encrypted-file` | `credentials.enc.json`, AES-256-GCM, one entry per connection, authenticated with the entry id                                                                                             |
| `none`           | Never persisted; asked once per session and kept in memory only                                                                                                                            |

The encrypted file's key comes from:

- `MTP_MASTER_PASSWORD` (scrypt, N=2^15, r=8, p=1, random salt) — the key never touches the disk; or
- a random 256-bit key in `master.key` (file mode 0600, directory 0700).

The key-file variant protects against accidental disclosure (synced or copied configuration
folders, screenshots, support bundles without the key) but **not** against someone who can read
files as your operating-system user. Use the OS credential store or `MTP_MASTER_PASSWORD` where that
matters.

MongoDB Compass passwords are encrypted by the operating system for Compass. They are deliberately
not decrypted; you enter them once.

## No secrets in arguments, output or logs

- Passwords are never accepted as command-line arguments; URIs containing passwords are rejected on
  the command line. Use saved connections, prompts, or `MTP_URI` / `MTP_PASSWORD` for automation.
- Connection strings are masked (`mongodb://user:****@host`) everywhere in the UI, error messages
  and the CLI's JSON output.
- The log file (`logs/mongo-terminal-pro.log`, mode 0600) is structured (pino); every message and
  argument is redacted and known secret fields are censored. Logs never go to the terminal while
  the dashboard runs.
- Configuration backups (`mtp config export`) contain no secrets.

## Subprocesses

`mongodump`, `mongorestore`, `mongoexport`, `mongoimport`, clipboard tools and external editors are
started with `child_process.spawn` **without a shell**; arguments are passed as an array and never
interpolated. Credentials for the Database Tools go into a temporary YAML `--config` file inside a
private temporary directory (mode 0600) that is deleted after the run, so they never appear in
process listings.

## Query and data safeguards

- Every query, count, distinct and pipeline runs with `maxTimeMS` (Settings) and a result cap; no
  code path reads an unbounded cursor into memory.
- Read pipelines get a trailing `$limit` so the server stops early; `$out`/`$merge` require write
  access and confirmation.
- Update operations must use update operators or a pipeline; empty filters on `updateMany` /
  `deleteMany` are called out and need typed confirmation.
- `$where` / `$function` usage is flagged.
- The query parser is a whitelist-based tokenizer — input is never evaluated as JavaScript, and
  `__proto__` keys are rejected.
- Imports validate before writing; exports refuse to overwrite files silently or to write into
  system directories.

## TLS

TLS follows the connection string (`mongodb+srv` implies TLS) unless forced on or off. Custom CA and
client certificate files are supported. Disabling certificate or host name validation is possible
for local testing only and is shown as a warning in the form and details panel.

## Reporting vulnerabilities

Please report security issues privately to the maintainers rather than in public issues.
