# Troubleshooting

Start with `mtp doctor`: it prints platform, terminal type, size, colour and Unicode detection,
configuration paths, the credential store in use and the Database Tools status.

## Display

| Problem                                                       | Solution                                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Boxes/arrows show as `?` or garbage (classic CMD, some fonts) | `mtp --ascii`, or Settings → Symbols → ascii. Windows Terminal renders Unicode correctly.                                           |
| Colours unreadable                                            | `--theme light` / `--theme dark`, or `--no-color`. `NO_COLOR` is respected.                                                         |
| Colours missing although supported                            | `FORCE_COLOR=3 mtp` (true colour) or `FORCE_COLOR=1` (16 colours).                                                                  |
| "Terminal too small"                                          | Enlarge to at least 40×12. Layouts get richer from 80×24 and side-by-side panes appear at 120 columns.                              |
| Flicker in old terminals                                      | Use a terminal with synchronized output support (Windows Terminal, iTerm2, kitty, WezTerm, recent VTE/GNOME Terminal).              |
| Mouse wheel does nothing                                      | It is opt-in: `mtp --mouse` or Settings → Mouse wheel (takes effect on restart). Text selection is unaffected when it is off.       |
| Keys do nothing in tmux/screen                                | Make sure `TERM` is `screen-256color`/`tmux-256color` and that `escape-time` is low (`set -sg escape-time 10`).                     |
| Ctrl+S freezes the terminal                                   | Only happens outside the dashboard (flow control). Inside the dashboard raw mode is used; run `stty -ixon` in your shell if needed. |

## Starting

| Problem                                   | Solution                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `needs an interactive terminal (TTY)`     | Run in a real terminal. In Git Bash/mintty use `winpty mtp`. Scripts should use the CLI commands.                    |
| `mtp: command not found`                  | Ensure npm's global `bin` directory is on `PATH` (`npm prefix -g`). On Windows reopen the terminal after installing. |
| PowerShell: `running scripts is disabled` | Use `mtp.cmd`, or `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.                                             |
| `Unsupported engine`                      | Upgrade Node.js to 22.12 or newer.                                                                                   |

## Connecting

| Error                                             | Likely cause                                                                                                                                                          |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cannot reach MongoDB / Server selection timed out | Wrong host/port, firewall, VPN, Atlas IP access list; replica-set member host names not resolvable from your machine (try `directConnection=true` for a single node). |
| Host name could not be resolved / `querySrv`      | DNS does not resolve the `mongodb+srv` record; check the cluster name or your DNS.                                                                                    |
| Connection refused                                | Nothing is listening on that port.                                                                                                                                    |
| Authentication failed                             | Username, password or `authSource` (usually `admin`).                                                                                                                 |
| TLS error                                         | Provide the CA file; for self-signed test certificates enable "Allow invalid certs" (local only).                                                                     |
| Not authorised                                    | Your MongoDB user lacks the role for that action.                                                                                                                     |

## Credentials

| Message                                                                       | Meaning                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| "No usable OS credential store was found … using the encrypted file fallback" | Normal on headless Linux/SSH. Optionally set `MTP_MASTER_PASSWORD`.      |
| "Credentials are protected by a master password"                              | The encrypted file was created with `MTP_MASTER_PASSWORD`; set it again. |
| "The master key file is missing"                                              | `master.key` was deleted; re-enter the passwords (edit the connection).  |
| macOS asks for Keychain access                                                | Allow `node` to access the `mongo-terminal-pro` items.                   |

## Data operations

| Problem                           | Solution                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "requires write access"           | Press `W` (dashboard) or add `--write` (CLI).                                                                                                           |
| Operation timed out               | Narrow the filter, add an index, or raise the timeout in Settings.                                                                                      |
| Import stopped at a duplicate key | Use `--duplicates skip` (keeps existing documents) or `--mode upsert` (replaces).                                                                       |
| Import says nothing was written   | Validation found invalid records; see the listed errors or `--error-report`.                                                                            |
| Export refused                    | The target exists (`--overwrite`), the folder is not writable, or it is a system directory.                                                             |
| Count shows `~`                   | Estimated from metadata. Press `x` on the collection overview for an exact (bounded) count.                                                             |
| Copy to clipboard fails over SSH  | Your terminal must support OSC 52 (most modern terminals; enable it in tmux with `set -g set-clipboard on`). You are offered to save to a file instead. |

## Backup / restore

| Problem                                 | Solution                                                                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mongodump was not found`               | Install MongoDB Database Tools (`mtp tools` shows how) or set `MTP_MONGODUMP_PATH`.                                                                |
| Backup `verification-failed`            | The dump exists but did not verify (count mismatch or unreadable file). Check disk space and the tool output; the backup is not marked successful. |
| Restore fails with duplicate key errors | Target collections already contain those `_id`s. Restore into another database (`--from-db/--to-db`) or use `--drop` if replacing is intended.     |

## Logs

Logs are in `<config dir>/logs/mongo-terminal-pro.log` (`mtp config path`). Raise detail with
Settings → Log level → debug. Secrets are always redacted, so logs can be shared.
