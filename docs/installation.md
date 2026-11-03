# Installation

Mongo Terminal Pro is a Node.js command-line application. It needs **Node.js 22.12 or newer**
(the current LTS lines are 22 and 24). The optional backup/restore features additionally need the
official **MongoDB Database Tools**.

## Install

```bash
npm install -g mongo-terminal-pro
mongo-terminal        # or the short alias
mtp
```

Run without installing:

```bash
npx mongo-terminal-pro
npx mongo-terminal-pro databases -c "Local"
```

Check the installation:

```bash
mtp --version
mtp doctor            # platform, terminal capabilities, credential storage, Database Tools
```

## Windows 10 / 11

1. Install Node.js LTS: `winget install OpenJS.NodeJS.LTS` (or the installer from nodejs.org).
2. Open **Windows Terminal**, PowerShell or CMD and run `npm install -g mongo-terminal-pro`.
3. Start with `mtp`.
4. Optional, for backups: `winget install MongoDB.DatabaseTools`, then make sure
   `C:\Program Files\MongoDB\Tools\100\bin` is on `PATH` (or set `MTP_MONGODUMP_PATH` /
   `MTP_MONGORESTORE_PATH`). Restart the terminal.

Notes:

- Windows Terminal and VS Code render Unicode box drawing and true colour. The classic console
  (CMD / PowerShell window without Windows Terminal) is detected and gets ASCII borders
  automatically; force either mode with `--ascii` / `--unicode`.
- Passwords are stored in **Windows Credential Manager**.
- Git Bash / mintty does not provide a real console to Node.js; use `winpty mtp` or Windows Terminal.
- If PowerShell blocks `mtp.ps1` (execution policy), run `mtp.cmd` or
  `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## macOS

```bash
brew install node                       # or nvm install --lts
npm install -g mongo-terminal-pro
mtp
brew tap mongodb/brew && brew install mongodb-database-tools   # optional
```

Passwords are stored in the **macOS Keychain** (you may be asked to allow access the first time).
Terminal.app and iTerm2 are supported; iTerm2 and recent Terminal.app versions also support the
OSC 52 clipboard sequence used over SSH.

## Ubuntu / Debian / Fedora / other Linux

Install Node.js 22+ via your distribution, [NodeSource](https://github.com/nodesource/distributions)
or [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install --lts
npm install -g mongo-terminal-pro
mtp
```

MongoDB Database Tools (optional):

```bash
# Ubuntu/Debian, after adding the MongoDB apt repository
sudo apt-get install mongodb-database-tools
# Fedora/RHEL, after adding the MongoDB yum repository
sudo dnf install mongodb-database-tools
```

Passwords go to the **Secret Service** (GNOME Keyring, KWallet). On headless servers and SSH
sessions without a keyring daemon, Mongo Terminal Pro falls back to an encrypted file in the
configuration directory — see [security.md](security.md).

## Permissions for global installs

If `npm install -g` fails with `EACCES`, do **not** use `sudo npm`. Either use nvm (installs into
your home directory) or set a user prefix:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"   # add to ~/.bashrc / ~/.zshrc
```

## Native dependency

Secure credential storage uses the optional dependency `@napi-rs/keyring`, which ships prebuilt
binaries for Windows (x64/arm64), macOS (x64/arm64) and Linux (glibc/musl, x64/arm64). If it
cannot be installed or loaded, the application still works and uses the encrypted file fallback.

## Uninstall

```bash
npm uninstall -g mongo-terminal-pro
```

Your configuration stays in the configuration directory (`mtp config path` shows it). Delete that
folder to remove saved connections and history. Passwords in the OS credential store are listed
under the service name `mongo-terminal-pro`.
