import {
  bsonType,
  UUID,
  type Binary,
  type Decimal128,
  type Document,
  type Long,
  type ObjectId,
  type Timestamp,
} from '../../utils/bson.js';
import { truncate } from '../../utils/formatting.js';
import { isPlainObject } from '../../utils/validation.js';
import type { ThemeColors } from '../themes/theme.js';

export type ValueKind =
  'string' | 'number' | 'boolean' | 'null' | 'objectId' | 'date' | 'special' | 'object' | 'array';

export function valueKind(value: unknown): ValueKind {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' || typeof value === 'bigint') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  const t = bsonType(value);
  if (t === 'ObjectId') return 'objectId';
  if (t === 'Int32' || t === 'Double' || t === 'Long' || t === 'Decimal128') return 'number';
  if (t) return 'special';
  if (value instanceof RegExp) return 'special';
  return isPlainObject(value) ? 'object' : 'special';
}

export function kindColor(kind: ValueKind, colors: ThemeColors): string {
  switch (kind) {
    case 'string':
      return colors.json.string;
    case 'number':
      return colors.json.number;
    case 'boolean':
      return colors.json.boolean;
    case 'null':
      return colors.json.null;
    case 'objectId':
      return colors.json.objectId;
    case 'date':
      return colors.json.date;
    case 'special':
      return colors.json.special;
    default:
      return colors.json.punctuation;
  }
}

/**
 * Renders a scalar BSON value in shell notation, e.g. ObjectId('…'), ISODate('…').
 * 'display' shows Int32/Double as plain numbers; 'shell' keeps their exact type for editing.
 */
export function formatScalar(value: unknown, mode: 'display' | 'shell' = 'display'): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number')
    return Number.isFinite(value)
      ? String(value)
      : value > 0
        ? 'Infinity'
        : Number.isNaN(value)
          ? 'NaN'
          : '-Infinity';
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : `ISODate('${value.toISOString()}')`;
  const t = bsonType(value);
  if (t === 'ObjectId') return `ObjectId('${(value as ObjectId).toHexString()}')`;
  if (t === 'Decimal128') return `NumberDecimal('${(value as Decimal128).toString()}')`;
  if (t === 'Long') return `NumberLong('${(value as Long).toString()}')`;
  if (t === 'Binary') {
    const bin = value as Binary;
    if (bin.sub_type === 4) return `UUID('${new UUID(bin.buffer).toHexString(true)}')`;
    const b64 = Buffer.from(bin.buffer).toString('base64');
    return `BinData(${bin.sub_type}, '${b64.length > 40 ? `${b64.slice(0, 40)}…` : b64}')  [${bin.length()} bytes]`;
  }
  if (t === 'Timestamp') return `Timestamp({ t: ${(value as Timestamp).t}, i: ${(value as Timestamp).i} })`;
  if (t === 'Int32') {
    const n = (value as { value: number }).value;
    return mode === 'shell' ? `NumberInt(${n})` : String(n);
  }
  if (t === 'Double') {
    const n = (value as { value: number }).value;
    if (!Number.isFinite(n)) return Number.isNaN(n) ? 'NaN' : n > 0 ? 'Infinity' : '-Infinity';
    // A whole-number double would re-parse as an integer; keep its type explicitly when editing.
    return mode === 'shell' && Number.isInteger(n)
      ? `Double(${n})`
      : Number.isInteger(n) && mode === 'display'
        ? `${n}.0`
        : String(n);
  }
  if (t === 'BSONRegExp') {
    const r = value as unknown as { pattern: string; options: string };
    return `/${r.pattern}/${r.options}`;
  }
  if (t === 'MinKey') return 'MinKey()';
  if (t === 'MaxKey') return 'MaxKey()';
  if (t === 'Code') return `Code(${JSON.stringify((value as { code: string }).code)})`;
  if (t === 'DBRef')
    return `DBRef(${JSON.stringify((value as { collection: string }).collection)}, ${formatScalar((value as { oid: unknown }).oid)})`;
  if (value instanceof RegExp) return value.toString();
  return String(value);
}

/** One-line preview of a value (objects/arrays summarised). */
export function inlinePreview(value: unknown, maxWidth: number): string {
  const kind = valueKind(value);
  if (kind === 'array') {
    const arr = value as unknown[];
    const inner = arr
      .slice(0, 5)
      .map((v) => inlinePreview(v, 30))
      .join(', ');
    return truncate(`[${inner}${arr.length > 5 ? ', …' : ''}]`, maxWidth);
  }
  if (kind === 'object') {
    const entries = Object.entries(value as Document);
    const inner = entries
      .slice(0, 4)
      .map(([k, v]) => `${k}: ${inlinePreview(v, 24)}`)
      .join(', ');
    return truncate(`{ ${inner}${entries.length > 4 ? ', …' : ''} }`, maxWidth);
  }
  return truncate(formatScalar(value), maxWidth);
}

/** Single-line document summary used in document lists: _id first, then leading fields. */
export function documentSummary(doc: Document, maxWidth: number): string {
  const parts: string[] = [];
  if ('_id' in doc) parts.push(formatScalar(doc._id));
  for (const [k, v] of Object.entries(doc)) {
    if (k === '_id') continue;
    parts.push(`${k}: ${inlinePreview(v, 40)}`);
    if (parts.join('  ').length > maxWidth) break;
  }
  return truncate(parts.join('  '), maxWidth);
}

// ------------------------------------------------------------------------------------------------
// Tree flattening for the expandable JSON viewer
// ------------------------------------------------------------------------------------------------

export interface JsonLine {
  path: string;
  depth: number;
  key?: string;
  /** Rendered value text for scalars or a summary for collapsed containers. */
  text: string;
  kind: ValueKind | 'close';
  expandable: boolean;
  expanded: boolean;
  trailingComma: boolean;
}

export function flattenJson(
  value: unknown,
  expanded: Set<string>,
  rootKey?: string,
  maxLines = 5000,
): JsonLine[] {
  const lines: JsonLine[] = [];
  const visit = (v: unknown, path: string, depth: number, key: string | undefined, comma: boolean) => {
    if (lines.length >= maxLines) return;
    const kind = valueKind(v);
    if (kind === 'object' || kind === 'array') {
      const entries: [string, unknown][] =
        kind === 'array' ? (v as unknown[]).map((x, i) => [String(i), x]) : Object.entries(v as Document);
      const isOpen = expanded.has(path);
      const open = kind === 'array' ? '[' : '{';
      const close = kind === 'array' ? ']' : '}';
      if (!isOpen || entries.length === 0) {
        const count =
          kind === 'array'
            ? `${entries.length} item${entries.length === 1 ? '' : 's'}`
            : `${entries.length} field${entries.length === 1 ? '' : 's'}`;
        lines.push({
          path,
          depth,
          key,
          text: entries.length === 0 ? `${open}${close}` : `${open} … ${close}  ${count}`,
          kind,
          expandable: entries.length > 0,
          expanded: false,
          trailingComma: comma,
        });
        return;
      }
      lines.push({
        path,
        depth,
        key,
        text: open,
        kind,
        expandable: true,
        expanded: true,
        trailingComma: false,
      });
      entries.forEach(([k, child], i) =>
        visit(child, `${path}.${k}`, depth + 1, kind === 'array' ? undefined : k, i < entries.length - 1),
      );
      lines.push({
        path: `${path}#close`,
        depth,
        text: close,
        kind: 'close',
        expandable: false,
        expanded: false,
        trailingComma: comma,
      });
      return;
    }
    lines.push({
      path,
      depth,
      key,
      text: formatScalar(v),
      kind,
      expandable: false,
      expanded: false,
      trailingComma: comma,
    });
  };
  visit(value, '$', 0, rootKey, false);
  return lines;
}

/** Paths of all containers up to a depth (used for "expand all" / initial expansion). */
export function containerPaths(value: unknown, maxDepth: number): string[] {
  const out: string[] = [];
  const visit = (v: unknown, path: string, depth: number) => {
    const kind = valueKind(v);
    if ((kind === 'object' || kind === 'array') && depth <= maxDepth) {
      out.push(path);
      const entries: [string, unknown][] =
        kind === 'array' ? (v as unknown[]).map((x, i) => [String(i), x]) : Object.entries(v as Document);
      for (const [k, child] of entries.slice(0, 500)) visit(child, `${path}.${k}`, depth + 1);
    }
  };
  visit(value, '$', 0);
  return out;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Serialises a document in mongo-shell syntax for editing. Unlike the display formatter this is
 * lossless for common BSON types and is accepted back by `parseMongoValue`.
 */
export function toShellString(value: unknown, indent = 2, depth = 0): string {
  const pad = ' '.repeat(indent * (depth + 1));
  const close = ' '.repeat(indent * depth);
  const kind = valueKind(value);
  if (kind === 'array') {
    const arr = value as unknown[];
    if (arr.length === 0) return '[]';
    return `[\n${arr.map((v) => `${pad}${toShellString(v, indent, depth + 1)}`).join(',\n')}\n${close}]`;
  }
  if (kind === 'object') {
    const entries = Object.entries(value as Document);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([k, v]) => `${pad}${IDENTIFIER.test(k) ? k : JSON.stringify(k)}: ${toShellString(v, indent, depth + 1)}`).join(',\n')}\n${close}}`;
  }
  if (bsonType(value) === 'Binary' && (value as Binary).sub_type !== 4) {
    const bin = value as Binary;
    return `BinData(${bin.sub_type}, '${Buffer.from(bin.buffer).toString('base64')}')`;
  }
  return formatScalar(value, 'shell');
}
