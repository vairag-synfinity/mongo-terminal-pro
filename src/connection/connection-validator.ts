import type { ConnectionDraft } from './connection-types.js';
import { isLocalUri, parseConnectionString } from './manual-connection.js';

export interface DraftValidation {
  valid: boolean;
  errors: Partial<Record<keyof ConnectionDraft | 'general', string>>;
  warnings: string[];
}

const SUPPORTED_MECHANISMS = new Set([
  'SCRAM-SHA-1',
  'SCRAM-SHA-256',
  'MONGODB-X509',
  'MONGODB-AWS',
  'GSSAPI',
  'PLAIN',
  'MONGODB-OIDC',
]);

export function validateUri(uri: string): string | undefined {
  const trimmed = uri.trim();
  if (!/^mongodb(\+srv)?:\/\//i.test(trimmed)) return 'URI must start with mongodb:// or mongodb+srv://';
  try {
    const cs = parseConnectionString(trimmed);
    if (cs.hosts.length === 0) return 'URI must contain at least one host';
    if (cs.isSRV && cs.hosts.length > 1) return 'mongodb+srv:// URIs accept exactly one host name';
    if (cs.isSRV && /:\d+$/.test(cs.hosts[0] ?? '')) return 'mongodb+srv:// URIs cannot include a port';
  } catch (error) {
    return `Invalid connection string: ${(error as Error).message.replace(/mongodb(\+srv)?:\/\/\S+/g, '<uri>')}`;
  }
  return undefined;
}

export function validateDraft(draft: ConnectionDraft, existingNames: string[] = []): DraftValidation {
  const errors: DraftValidation['errors'] = {};
  const warnings: string[] = [];
  const name = draft.name?.trim() ?? '';
  if (!name) errors.name = 'Connection name is required';
  else if (name.length > 100) errors.name = 'Name must be at most 100 characters';
  else if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase()))
    errors.name = 'A connection with this name already exists';

  let uriForChecks: string | undefined;
  if (draft.uri && draft.uri.trim()) {
    const uriError = validateUri(draft.uri);
    if (uriError) errors.uri = uriError;
    else uriForChecks = draft.uri.trim();
  } else {
    const host = draft.host?.trim() ?? '';
    if (!host) errors.host = 'Host or URI is required';
    else if (/[\s/@?]/.test(host.replace(/,\s*/g, ',')))
      errors.host = 'Host must not contain spaces, "/", "@" or "?"';
    if (draft.port !== undefined && (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535)) {
      errors.port = 'Port must be between 1 and 65535';
    }
    if (draft.srv && draft.port !== undefined && draft.port !== 27017) {
      warnings.push('Ports are ignored for mongodb+srv connections.');
    }
    if (host && !errors.host) uriForChecks = `mongodb${draft.srv ? '+srv' : ''}://${host.split(',')[0]}`;
  }

  if (draft.password && !draft.username && !draft.uri?.includes('@')) {
    errors.username = 'Username is required when a password is provided';
  }
  if (draft.authMechanism && !SUPPORTED_MECHANISMS.has(draft.authMechanism.toUpperCase())) {
    errors.authMechanism = `Unsupported mechanism. Use one of: ${[...SUPPORTED_MECHANISMS].join(', ')}`;
  }
  if (
    draft.connectTimeoutMs !== undefined &&
    (draft.connectTimeoutMs < 500 || draft.connectTimeoutMs > 120_000)
  ) {
    errors.connectTimeoutMs = 'Timeout must be between 500 and 120000 ms';
  }
  if (draft.tls?.allowInvalidCertificates || draft.tls?.allowInvalidHostnames) {
    warnings.push('TLS certificate validation is disabled — only do this for local testing.');
  }
  if (uriForChecks && !errors.uri && !errors.host) {
    const local = isLocalUri(uriForChecks);
    const tlsOn =
      draft.tls?.mode === 'on' ||
      /^mongodb\+srv:/i.test(uriForChecks) ||
      /[?&](tls|ssl)=true/i.test(draft.uri ?? '');
    if (!local && !tlsOn && draft.tls?.mode !== 'on') {
      warnings.push(
        'This is a remote server without TLS enabled; credentials and data may travel unencrypted.',
      );
    }
  }
  if (draft.uri && /^mongodb(\+srv)?:\/\/[^@/]*:[^@/]*@/i.test(draft.uri)) {
    warnings.push('The password will be moved out of the URI into secure credential storage.');
  }
  return { valid: Object.keys(errors).length === 0, errors, warnings };
}
