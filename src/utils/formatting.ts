const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(bytes: number | null | undefined, fractionDigits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(fractionDigits)} ${BYTE_UNITS[unit]}`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatCount(value: number | null | undefined, estimated: boolean): string {
  const formatted = formatNumber(value);
  return estimated && formatted !== '—' ? `~${formatted}` : formatted;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatDateTime(date: Date | string | number | null | undefined): string {
  if (date === null || date === undefined) return '—';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

/** Display width aware of wide (CJK/emoji) characters, without ANSI codes. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
    if (code >= 0x300 && code <= 0x36f) continue; // combining marks
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd))
  );
}

/** Truncates to a display width, appending an ellipsis when cut. */
export function truncate(text: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0) return '';
  const singleLine = text.replace(/[\r\n\t]+/g, ' ');
  if (displayWidth(singleLine) <= maxWidth) return singleLine;
  const target = Math.max(0, maxWidth - displayWidth(ellipsis));
  let out = '';
  let width = 0;
  for (const char of singleLine) {
    const w = displayWidth(char);
    if (width + w > target) break;
    out += char;
    width += w;
  }
  return out + ellipsis;
}

export function padEnd(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : text + ' '.repeat(width - w);
}

export function padStart(text: string, width: number): string {
  const w = displayWidth(text);
  return w >= width ? text : ' '.repeat(width - w) + text;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}

export function timestampForFilename(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
}
