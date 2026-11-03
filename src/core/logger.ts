import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import { redactObject, redactText } from '../security/sensitive-data-filter.js';

/**
 * Structured file logging. Logs never go to the terminal while the TUI is running (that would
 * corrupt the screen) and all messages/arguments are redacted before serialisation.
 */
export function createLogger(logFile: string | undefined, level: string): Logger {
  if (!logFile || level === 'silent') return pino({ level: 'silent' });
  try {
    mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  } catch {
    return pino({ level: 'silent' });
  }
  // Synchronous writes: log volume is low, and an async destination that is still opening when a
  // short CLI command exits makes pino's exit flush throw.
  const destination = pino.destination({ dest: logFile, sync: true, mkdir: true, mode: 0o600 });
  return pino(
    {
      level,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [
          'password',
          '*.password',
          'uri',
          '*.uri',
          'connectionString',
          '*.connectionString',
          'auth',
          '*.auth',
          'secret',
          '*.secret',
        ],
        censor: '****',
      },
      hooks: {
        logMethod(args, method) {
          const safe = args.map((a) =>
            typeof a === 'string' ? redactText(a) : redactObject(a),
          ) as Parameters<typeof method>;
          method.apply(this, safe);
        },
      },
    },
    destination,
  );
}

export type { Logger };
