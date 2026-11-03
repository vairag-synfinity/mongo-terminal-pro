import { redactText } from '../security/sensitive-data-filter.js';

export type ErrorCode =
  | 'READ_ONLY'
  | 'VALIDATION'
  | 'NOT_CONNECTED'
  | 'CONNECTION'
  | 'AUTH'
  | 'TIMEOUT'
  | 'PERMISSION'
  | 'NOT_FOUND'
  | 'CANCELLED'
  | 'TOOLS_MISSING'
  | 'FILESYSTEM'
  | 'UNKNOWN';

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode = 'UNKNOWN',
    public readonly hint?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export class ReadOnlyError extends AppError {
  constructor(message: string) {
    super(message, 'READ_ONLY', 'Press W to enable write access, or use --write on the CLI.');
    this.name = 'ReadOnlyError';
  }
}

export class ValidationError extends AppError {
  constructor(
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message, 'VALIDATION');
    this.name = 'ValidationError';
  }
}

export class NotConnectedError extends AppError {
  constructor() {
    super(
      'No active connection',
      'NOT_CONNECTED',
      'Open the Connection Manager and connect to a server first.',
    );
    this.name = 'NotConnectedError';
  }
}

export class CancelledError extends AppError {
  constructor(message = 'Operation cancelled') {
    super(message, 'CANCELLED');
    this.name = 'CancelledError';
  }
}

export interface FriendlyError {
  title: string;
  message: string;
  hint?: string;
  code: ErrorCode;
}

interface MongoLikeError {
  name?: string;
  code?: number | string;
  codeName?: string;
  message?: string;
  errmsg?: string;
  cause?: unknown;
}

/** Converts any thrown value into a redacted, user-friendly error description. */
export function toFriendlyError(error: unknown): FriendlyError {
  if (error instanceof AppError) {
    return {
      title: titleFor(error.code),
      message: redactText(error.message),
      hint: error.hint,
      code: error.code,
    };
  }
  const e = (error ?? {}) as MongoLikeError;
  const message = redactText(String(e.message ?? e.errmsg ?? error ?? 'Unknown error'));
  const name = e.name ?? '';
  const code = e.code;

  if (name === 'MongoServerSelectionError' || /Server selection timed out/i.test(message)) {
    return {
      title: 'Cannot reach MongoDB',
      message,
      hint: 'Check host/port, firewall, VPN and Atlas IP access list. For replica sets ensure member hostnames resolve from this machine.',
      code: 'CONNECTION',
    };
  }
  if (code === 18 || /Authentication failed/i.test(message) || name === 'MongoMissingCredentialsError') {
    return {
      title: 'Authentication failed',
      message,
      hint: 'Verify username, password and authentication database (authSource; usually "admin").',
      code: 'AUTH',
    };
  }
  if (code === 13 || e.codeName === 'Unauthorized' || /not authorized/i.test(message)) {
    return {
      title: 'Not authorised',
      message,
      hint: 'Your MongoDB user lacks the required role for this action. Mongo Terminal Pro never bypasses server permissions.',
      code: 'PERMISSION',
    };
  }
  if (code === 50 || e.codeName === 'MaxTimeMSExpired' || /operation exceeded time limit/i.test(message)) {
    return {
      title: 'Operation timed out',
      message,
      hint: 'Narrow the filter, add an index, or raise the timeout in Settings.',
      code: 'TIMEOUT',
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|querySrv/i.test(message)) {
    return {
      title: 'Host name could not be resolved',
      message,
      hint: 'Check the host name. For mongodb+srv:// URIs your DNS must support SRV lookups.',
      code: 'CONNECTION',
    };
  }
  if (/ECONNREFUSED/i.test(message)) {
    return {
      title: 'Connection refused',
      message,
      hint: 'Is mongod running and listening on that port?',
      code: 'CONNECTION',
    };
  }
  if (code === 11000) {
    return {
      title: 'Duplicate key',
      message,
      hint: 'A document with the same unique key already exists.',
      code: 'VALIDATION',
    };
  }
  if (/self[- ]signed|certificate|SSL|TLS/i.test(message) && /(error|fail|unable)/i.test(message)) {
    return {
      title: 'TLS error',
      message,
      hint: 'Provide the CA file in the connection TLS settings. Only allow invalid certificates for local testing.',
      code: 'CONNECTION',
    };
  }
  if (/EACCES|EPERM/i.test(message)) {
    return {
      title: 'Permission denied',
      message,
      hint: 'Choose a location you can write to.',
      code: 'FILESYSTEM',
    };
  }
  if (/ENOENT/i.test(message)) {
    return { title: 'File not found', message, code: 'FILESYSTEM' };
  }
  return { title: 'Error', message, code: 'UNKNOWN' };
}

function titleFor(code: ErrorCode): string {
  switch (code) {
    case 'READ_ONLY':
      return 'Read-only mode';
    case 'VALIDATION':
      return 'Invalid input';
    case 'NOT_CONNECTED':
      return 'Not connected';
    case 'CONNECTION':
      return 'Connection error';
    case 'AUTH':
      return 'Authentication failed';
    case 'TIMEOUT':
      return 'Timed out';
    case 'PERMISSION':
      return 'Not authorised';
    case 'NOT_FOUND':
      return 'Not found';
    case 'CANCELLED':
      return 'Cancelled';
    case 'TOOLS_MISSING':
      return 'MongoDB Database Tools not found';
    case 'FILESYSTEM':
      return 'File system error';
    default:
      return 'Error';
  }
}

export function formatErrorLine(error: unknown): string {
  const f = toFriendlyError(error);
  return f.hint ? `${f.title}: ${f.message}\n  Hint: ${f.hint}` : `${f.title}: ${f.message}`;
}
