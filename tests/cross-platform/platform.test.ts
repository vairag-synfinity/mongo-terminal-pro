import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { installInstructions, toolUri } from '../../src/backup/database-tools.js';
import { ConnectionProfileSchema } from '../../src/connection/connection-types.js';
import { getAppPaths, resolveConfigDir, resolveDataDir } from '../../src/config/paths.js';
import {
  detectTerminalProgram,
  findExecutable,
  getPlatformInfo,
  normalizePlatform,
} from '../../src/utils/platform.js';
import {
  detectColorLevel,
  detectUnicode,
  isMouseSequence,
  parseMouseInput,
} from '../../src/utils/terminal.js';
import { tmpDir } from '../helpers/tmp.js';

describe('configuration paths per operating system', () => {
  it('uses %APPDATA% on Windows', () => {
    expect(
      resolveConfigDir({
        platform: 'win32',
        home: 'C:\\Users\\Ada',
        env: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
      }),
    ).toBe('C:\\Users\\Ada\\AppData\\Roaming\\mongo-terminal-pro');
    expect(resolveConfigDir({ platform: 'win32', home: 'C:\\Users\\Ada', env: {} })).toBe(
      'C:\\Users\\Ada\\AppData\\Roaming\\mongo-terminal-pro',
    );
    expect(resolveDataDir({ platform: 'win32', home: 'C:\\Users\\Ada', env: {} })).toBe(
      'C:\\Users\\Ada\\Documents\\MongoTerminalPro',
    );
  });

  it('uses Application Support on macOS', () => {
    expect(resolveConfigDir({ platform: 'darwin', home: '/Users/ada', env: {} })).toBe(
      '/Users/ada/Library/Application Support/mongo-terminal-pro',
    );
  });

  it('follows XDG on Linux', () => {
    expect(resolveConfigDir({ platform: 'linux', home: '/home/ada', env: {} })).toBe(
      '/home/ada/.config/mongo-terminal-pro',
    );
    expect(resolveConfigDir({ platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: '/xdg' } })).toBe(
      '/xdg/mongo-terminal-pro',
    );
    expect(
      resolveConfigDir({ platform: 'linux', home: '/home/ada', env: { XDG_CONFIG_HOME: 'relative' } }),
    ).toBe('/home/ada/.config/mongo-terminal-pro');
    expect(resolveDataDir({ platform: 'linux', home: '/home/ada', env: {} })).toBe(
      '/home/ada/.local/share/mongo-terminal-pro',
    );
  });

  it('honours MTP_CONFIG_DIR and derives all file paths', () => {
    const p = getAppPaths({ platform: 'linux', home: '/h', env: { MTP_CONFIG_DIR: '/custom' } });
    expect(p.settingsFile).toBe('/custom/settings.json');
    expect(p.logFile).toBe('/custom/logs/mongo-terminal-pro.log');
  });
});

describe('platform detection', () => {
  it('normalises platforms', () => {
    expect(normalizePlatform('win32')).toBe('win32');
    expect(normalizePlatform('freebsd')).toBe('other');
  });

  it('detects terminals and SSH sessions', () => {
    expect(detectTerminalProgram({ WT_SESSION: 'x' })).toBe('Windows Terminal');
    expect(detectTerminalProgram({ TERM_PROGRAM: 'vscode' })).toBe('VS Code');
    expect(detectTerminalProgram({ TERM_PROGRAM: 'iTerm.app' })).toBe('iTerm2');
    expect(getPlatformInfo({ SSH_CONNECTION: '1 2 3 4' }).isSSH).toBe(true);
    expect(getPlatformInfo({}, 'linux').isLinux).toBe(true);
  });

  it('finds executables on PATH without a shell (POSIX)', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'mongodump');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    expect(findExecutable('mongodump', { PATH: `/nonexistent:${dir}` }, 'linux')).toBe(file);
    expect(findExecutable('missing-tool', { PATH: dir }, 'linux')).toBeUndefined();
  });

  it('honours PATHEXT on Windows', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'mongodump.exe'), '');
    if (process.platform === 'win32') {
      expect(findExecutable('mongodump', { Path: dir, PATHEXT: '.COM;.EXE' }, 'win32')?.toLowerCase()).toBe(
        path.join(dir, 'mongodump.exe').toLowerCase(),
      );
    } else {
      // On POSIX hosts the Windows path API cannot resolve real files; ensure it does not throw.
      expect(() =>
        findExecutable('mongodump', { Path: 'C:\\Tools', PATHEXT: '.EXE' }, 'win32'),
      ).not.toThrow();
    }
  });

  it('gives OS-specific Database Tools install instructions', () => {
    expect(installInstructions('win32').join(' ')).toMatch(/winget/);
    expect(installInstructions('darwin').join(' ')).toMatch(/brew/);
    expect(installInstructions('linux').join(' ')).toMatch(/apt-get|dnf/);
  });
});

describe('terminal capability detection', () => {
  it('respects NO_COLOR and FORCE_COLOR', () => {
    expect(detectColorLevel({ NO_COLOR: '1', TERM: 'xterm-256color' }, true, 'linux')).toBe(0);
    expect(detectColorLevel({ FORCE_COLOR: '3' }, false, 'linux')).toBe(3);
    expect(detectColorLevel({ FORCE_COLOR: '0' }, true, 'linux')).toBe(0);
  });

  it('detects colour depth', () => {
    expect(detectColorLevel({ TERM: 'xterm-256color' }, true, 'linux')).toBe(2);
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, true, 'linux')).toBe(3);
    expect(detectColorLevel({ TERM: 'dumb' }, true, 'linux')).toBe(0);
    expect(detectColorLevel({ TERM: 'xterm' }, false, 'linux')).toBe(0); // piped output
    expect(detectColorLevel({ WT_SESSION: '1' }, true, 'win32')).toBe(3);
    expect(detectColorLevel({}, true, 'win32')).toBe(2);
  });

  it('falls back to ASCII on legacy consoles and non-UTF-8 locales', () => {
    expect(detectUnicode({}, 'win32')).toBe(false); // legacy conhost (CMD / PowerShell)
    expect(detectUnicode({ WT_SESSION: '1' }, 'win32')).toBe(true);
    expect(detectUnicode({ TERM_PROGRAM: 'vscode' }, 'win32')).toBe(true);
    expect(detectUnicode({ LANG: 'en_US.UTF-8' }, 'linux')).toBe(true);
    expect(detectUnicode({ LANG: 'C' }, 'linux')).toBe(false);
    expect(detectUnicode({ TERM: 'linux', LANG: 'en_US.UTF-8' }, 'linux')).toBe(false); // Linux VT console
    expect(detectUnicode({}, 'darwin')).toBe(true);
    expect(detectUnicode({ MTP_ASCII: '1', LANG: 'en_US.UTF-8' }, 'linux')).toBe(false);
  });

  it('parses SGR mouse wheel and click reports', () => {
    expect(parseMouseInput('\u001B[<64;10;5M')).toEqual([{ kind: 'wheel-up', button: 64, x: 10, y: 5 }]);
    expect(parseMouseInput('\u001B[<65;1;1M\u001B[<0;3;4m')).toEqual([
      { kind: 'wheel-down', button: 65, x: 1, y: 1 },
      { kind: 'release', button: 0, x: 3, y: 4 },
    ]);
    expect(parseMouseInput('hello')).toEqual([]);
    expect(isMouseSequence('[<64;10;5M')).toBe(true);
    expect(isMouseSequence('abc')).toBe(false);
  });
});

describe('Database Tools URI', () => {
  it('never includes the password and carries TLS options', () => {
    const now = new Date().toISOString();
    const profile = ConnectionProfileSchema.parse({
      id: '1',
      name: 'x',
      uri: 'mongodb://db.example.com:27017/?replicaSet=rs0',
      username: 'svc user',
      authSource: 'admin',
      tls: {
        mode: 'on',
        caFile: '/etc/ca.pem',
        allowInvalidCertificates: false,
        allowInvalidHostnames: false,
      },
      createdAt: now,
      updatedAt: now,
    });
    const uri = toolUri(profile);
    expect(uri).toContain('svc%20user@');
    expect(uri).not.toMatch(/svc%20user:[^@]/);
    expect(uri).toContain('tls=true');
    expect(uri).toContain('tlsCAFile=');
    expect(uri).toContain('authSource=admin');
  });
});
