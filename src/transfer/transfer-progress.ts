export interface TransferProgress {
  phase: 'validating' | 'writing' | 'exporting' | 'done';
  processed: number;
  total?: number;
  totalIsEstimate?: boolean;
  bytes: number;
  totalBytes?: number;
  ratePerSecond: number;
  etaSeconds?: number;
  elapsedMs: number;
  /** Current item (collection name when exporting a database). */
  current?: string;
}

export type ProgressCallback = (progress: TransferProgress) => void;

/** Tracks progress and throttles callbacks so the UI is not flooded. */
export class ProgressTracker {
  private readonly started = Date.now();
  private lastEmit = 0;
  processed = 0;
  bytes = 0;

  constructor(
    private readonly callback: ProgressCallback | undefined,
    public phase: TransferProgress['phase'],
    public total?: number,
    public totalBytes?: number,
    public totalIsEstimate = false,
    private readonly intervalMs = 100,
  ) {}

  current: string | undefined;

  snapshot(): TransferProgress {
    const elapsedMs = Date.now() - this.started;
    const seconds = elapsedMs / 1000;
    const ratePerSecond = seconds > 0 ? this.processed / seconds : 0;
    let etaSeconds: number | undefined;
    if (this.totalBytes && this.bytes > 0 && seconds > 0) {
      etaSeconds = ((this.totalBytes - this.bytes) / this.bytes) * seconds;
    } else if (this.total && ratePerSecond > 0) {
      etaSeconds = Math.max(0, (this.total - this.processed) / ratePerSecond);
    }
    return {
      phase: this.phase,
      processed: this.processed,
      total: this.total,
      totalIsEstimate: this.totalIsEstimate,
      bytes: this.bytes,
      totalBytes: this.totalBytes,
      ratePerSecond,
      etaSeconds,
      elapsedMs,
      current: this.current,
    };
  }

  tick(force = false): void {
    if (!this.callback) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < this.intervalMs) return;
    this.lastEmit = now;
    this.callback(this.snapshot());
  }

  finish(): TransferProgress {
    this.phase = 'done';
    const snap = this.snapshot();
    this.callback?.(snap);
    return snap;
  }
}

export function progressFraction(p: TransferProgress): number | undefined {
  if (p.totalBytes && p.totalBytes > 0) return Math.min(1, p.bytes / p.totalBytes);
  if (p.total && p.total > 0) return Math.min(1, p.processed / p.total);
  return undefined;
}
