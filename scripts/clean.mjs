// Cross-platform removal of the dist directory (no rm -rf in npm scripts).
import { rmSync } from 'node:fs';
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
