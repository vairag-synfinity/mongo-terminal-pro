#!/usr/bin/env node
// Executable entry for the `mongo-terminal`, `mtp` and `mongo-terminal-pro` commands.
import { main } from './index.js';

main().finally(() => {
  // Connections are closed by main(); exit explicitly so lingering handles (e.g. DNS/SRV
  // lookups or the async log writer) never keep a finished command alive. Give stdout a tick
  // to drain first.
  setImmediate(() => process.exit(process.exitCode ?? 0));
});
