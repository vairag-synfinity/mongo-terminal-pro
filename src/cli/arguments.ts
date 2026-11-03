import { InvalidArgumentError } from 'commander';
import type { Document } from 'mongodb';
import type { TransferFormat } from '../transfer/import-validator.js';
import { parseMongoObject } from '../utils/validation.js';

export function parsePositiveInt(label: string, max = Number.MAX_SAFE_INTEGER) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > max)
      throw new InvalidArgumentError(`${label} must be an integer between 1 and ${max}`);
    return n;
  };
}

export function parseNonNegativeInt(label: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0)
      throw new InvalidArgumentError(`${label} must be a non-negative integer`);
    return n;
  };
}

export function parseFormat(value: string): TransferFormat {
  const v = value.toLowerCase();
  if (v === 'json' || v === 'csv' || v === 'bson') return v;
  throw new InvalidArgumentError('format must be json, csv or bson');
}

export function parseJsonObjectArg(label: string) {
  return (value: string): Document => {
    try {
      return parseMongoObject(value, label);
    } catch (error) {
      throw new InvalidArgumentError((error as Error).message);
    }
  };
}

export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function oneOf<T extends string>(label: string, values: readonly T[]) {
  return (value: string): T => {
    if ((values as readonly string[]).includes(value)) return value as T;
    throw new InvalidArgumentError(`${label} must be one of: ${values.join(', ')}`);
  };
}

/**
 * Rejects connection strings that embed a password on the command line — they would be visible in
 * process listings and shell history.
 */
export function rejectInlineCredentials(uri: string): string {
  if (/^mongodb(\+srv)?:\/\/[^@/]*:[^@/]+@/i.test(uri)) {
    throw new InvalidArgumentError(
      'Do not put passwords in command-line arguments (they appear in shell history and process lists). ' +
        'Save the connection with "mongo-terminal connections add" or use the MTP_URI environment variable.',
    );
  }
  return uri;
}
