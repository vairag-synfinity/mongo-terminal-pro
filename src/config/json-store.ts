import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';

/** Creates a directory readable only by the current user (mode is ignored on Windows). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Atomically writes a file: data goes to a temporary sibling which is then renamed over the target,
 * so a crash never leaves a half-written configuration file.
 */
export async function writeFileAtomic(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, { mode });
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    // Windows can transiently refuse rename when the target is open by another process (AV scanners).
    if (process.platform === 'win32') {
      await new Promise((r) => setTimeout(r, 50));
      await fs.copyFile(tmp, file);
      await fs.rm(tmp, { force: true });
    } else {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }
}

export async function readJsonFile(file: string): Promise<unknown | undefined> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * A small typed JSON document store validated with Zod. Invalid files are moved aside (never
 * deleted) and replaced with defaults, so a corrupt file never prevents the app from starting.
 */
export class JsonStore<T> {
  private cache: T | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  public lastRecoveryMessage: string | undefined;

  constructor(
    public readonly file: string,
    private readonly schema: z.ZodType<T>,
    private readonly defaults: () => T,
  ) {}

  async read(): Promise<T> {
    if (this.cache !== undefined) return this.cache;
    const raw = await readJsonFile(this.file).catch(async (error: unknown) => {
      await this.quarantine(`unreadable JSON (${(error as Error).message})`);
      return undefined;
    });
    if (raw === undefined) {
      this.cache = this.defaults();
      return this.cache;
    }
    const parsed = this.schema.safeParse(raw);
    if (!parsed.success) {
      await this.quarantine('failed validation');
      this.cache = this.defaults();
      return this.cache;
    }
    this.cache = parsed.data;
    return this.cache;
  }

  async write(value: T): Promise<void> {
    const validated = this.schema.parse(value);
    this.cache = validated;
    const payload = `${JSON.stringify(validated, null, 2)}\n`;
    this.writeChain = this.writeChain.then(() => writeFileAtomic(this.file, payload));
    return this.writeChain;
  }

  async update(mutator: (current: T) => T | void): Promise<T> {
    const current = structuredClone(await this.read());
    const next = (mutator(current) ?? current) as T;
    await this.write(next);
    return next;
  }

  invalidate(): void {
    this.cache = undefined;
  }

  private async quarantine(reason: string): Promise<void> {
    const target = `${this.file}.corrupt-${Date.now()}`;
    try {
      await fs.rename(this.file, target);
      this.lastRecoveryMessage = `${path.basename(this.file)} ${reason}; moved to ${target} and defaults were used.`;
    } catch {
      this.lastRecoveryMessage = `${path.basename(this.file)} ${reason}; defaults were used.`;
    }
  }
}
