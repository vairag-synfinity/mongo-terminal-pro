/**
 * Single source of BSON classes for the whole application.
 *
 * The `bson` package ships separate CommonJS and ESM builds. The MongoDB driver (CommonJS) uses the
 * CommonJS build, so importing `bson` directly from ESM code would give *different* classes and
 * `instanceof ObjectId` checks against driver results would fail. Everything therefore comes from
 * the driver's own re-exports.
 */
import { BSON } from 'mongodb';

export {
  BSON,
  BSONRegExp,
  Binary,
  Code,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
  type Document,
} from 'mongodb';

export const EJSON = BSON.EJSON;

/** The BSON type tag of a value (`ObjectId`, `Decimal128`, …) — robust across module copies. */
export function bsonType(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const t = (value as { _bsontype?: unknown })._bsontype;
  return typeof t === 'string' ? t : undefined;
}
