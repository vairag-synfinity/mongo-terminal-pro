// Ensures the CLI entry has a shebang and executable permissions (ignored on Windows,
// where npm generates .cmd/.ps1 shims for "bin" entries).
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/cli/bin.js', import.meta.url));
const source = readFileSync(entry, 'utf8');
if (!source.startsWith('#!')) {
  writeFileSync(entry, `#!/usr/bin/env node\n${source}`);
}
if (process.platform !== 'win32') {
  chmodSync(entry, 0o755);
}
console.log('postbuild: CLI entry prepared at dist/cli/bin.js');
