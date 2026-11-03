import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach } from 'vitest';
import { getAppPaths, type AppPaths } from '../../src/config/paths.js';

const testScoped: string[] = [];
const fileScoped: string[] = [];

afterEach(() => {
  while (testScoped.length) rmSync(testScoped.pop() as string, { recursive: true, force: true });
});

// Registered at module level, so it runs once after all tests of the importing file.
afterAll(() => {
  while (fileScoped.length) rmSync(fileScoped.pop() as string, { recursive: true, force: true });
});

function make(prefix: string, list: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  list.push(dir);
  return dir;
}

function pathsIn(root: string): AppPaths {
  return getAppPaths({
    env: { MTP_CONFIG_DIR: path.join(root, 'config'), MTP_DATA_DIR: path.join(root, 'data') },
  });
}

/** A temporary directory removed after the current test. */
export function tmpDir(prefix = 'mtp-test-'): string {
  return make(prefix, testScoped);
}

/** A temporary directory for beforeAll setup, removed when the test file finishes. */
export function fileTmpDir(prefix = 'mtp-test-'): string {
  return make(prefix, fileScoped);
}

/** Isolated application paths, removed after the current test. */
export function tmpPaths(): AppPaths {
  return pathsIn(tmpDir());
}

/** Isolated application paths for beforeAll setup. */
export function fileTmpPaths(): AppPaths {
  return pathsIn(fileTmpDir());
}

export const FIXTURES = path.resolve('tests/fixtures');
