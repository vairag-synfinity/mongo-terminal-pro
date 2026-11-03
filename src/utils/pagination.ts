export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 500;

export function clampPageSize(size: number | undefined, max = MAX_PAGE_SIZE): number {
  if (size === undefined || !Number.isFinite(size)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(size)), max);
}

export interface PageInfo {
  /** Zero-based page index. */
  page: number;
  pageSize: number;
  /** Number of items on the current page. */
  itemCount: number;
  hasNext: boolean;
  hasPrevious: boolean;
  /** Total when known; may be an estimate. */
  total?: number;
  totalIsEstimate?: boolean;
  /** 'keyset' uses _id anchors (fast at any depth); 'offset' uses skip(). */
  strategy: 'keyset' | 'offset';
}

export function pageCount(total: number | undefined, pageSize: number): number | undefined {
  if (total === undefined) return undefined;
  return Math.max(1, Math.ceil(total / pageSize));
}

export function describePage(info: PageInfo): string {
  const start = info.itemCount === 0 ? 0 : info.page * info.pageSize + 1;
  const end = info.page * info.pageSize + info.itemCount;
  const pages = pageCount(info.total, info.pageSize);
  const totalText =
    info.total === undefined
      ? ''
      : ` of ${info.totalIsEstimate ? '~' : ''}${info.total.toLocaleString('en-US')}`;
  const pageText = pages === undefined ? `page ${info.page + 1}` : `page ${info.page + 1}/${pages}`;
  return `${start}-${end}${totalText} · ${pageText}`;
}

/**
 * Tracks anchors for keyset pagination. Anchor i is the last sort-key value of page i-1, so page i
 * is fetched with `{ _id: { $gt: anchor[i] } }` (or $lt when descending). Anchors are recorded as
 * pages are visited; jumping to an unvisited page falls back to offset pagination.
 */
export class KeysetAnchors<T> {
  private anchors: (T | null)[] = [null];

  reset(): void {
    this.anchors = [null];
  }

  get(page: number): T | null | undefined {
    return this.anchors[page];
  }

  has(page: number): boolean {
    return page === 0 || (page < this.anchors.length && this.anchors[page] !== undefined);
  }

  record(page: number, lastKey: T): void {
    // Pages after this one may have shifted (inserts/deletes), so forget later anchors.
    this.anchors.length = Math.max(this.anchors.length, page + 1);
    this.anchors[page + 1] = lastKey;
    this.anchors.length = page + 2;
  }
}

/** Computes the window of a list to render so the selected index stays visible. */
export function visibleWindow(
  total: number,
  selected: number,
  height: number,
  previousOffset = 0,
): { start: number; end: number } {
  if (height <= 0 || total === 0) return { start: 0, end: 0 };
  let start = Math.min(previousOffset, Math.max(0, total - height));
  if (selected < start) start = selected;
  if (selected >= start + height) start = selected - height + 1;
  start = Math.max(0, Math.min(start, Math.max(0, total - height)));
  return { start, end: Math.min(total, start + height) };
}
