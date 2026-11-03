/**
 * Redaction helpers. Every string that may reach the screen, a log file or an error report should
 * pass through `redactText` — connection strings and passwords must never be displayed.
 */

export const MASK = '****';

const URI_CREDENTIALS = /(mongodb(?:\+srv)?:\/\/)([^@/\s]+)@/gi;
const KEY_VALUE_SECRETS =
  /((?:password|passwd|pwd|secret|token|apikey|api_key|sslPEMKeyPassword|tlsCertificateKeyFilePassword)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&;,]+)/gi;
const QUERY_SECRETS = /([?&](?:password|authMechanismProperties|tlsCertificateKeyFilePassword)=)([^&\s]+)/gi;
const GENERIC_URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^:@/\s]+):([^@/\s]+)@/gi;

/** Masks the password part (and keeps the username) of connection strings. */
export function maskConnectionString(uri: string): string {
  return uri.replace(URI_CREDENTIALS, (_m, scheme: string, userinfo: string) => {
    const colon = userinfo.indexOf(':');
    if (colon === -1) return `${scheme}${userinfo}@`;
    return `${scheme}${userinfo.slice(0, colon)}:${MASK}@`;
  });
}

/** Redacts anything that looks like a credential inside free text. */
export function redactText(text: string): string {
  return maskConnectionString(text)
    .replace(GENERIC_URL_CREDENTIALS, (_m, scheme: string, user: string) => `${scheme}${user}:${MASK}@`)
    .replace(QUERY_SECRETS, (_m, key: string) => `${key}${MASK}`)
    .replace(KEY_VALUE_SECRETS, (_m, key: string) => `${key}${MASK}`);
}

const SENSITIVE_KEYS =
  /^(password|passwd|pwd|secret|token|apiKey|api_key|connectionSecrets|credentials?|auth)$/i;

/** Deep-redacts objects for logging. Values under sensitive keys are replaced entirely. */
export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 20) return value;
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1)) as T;
  if (value instanceof Error) {
    const copy = new Error(redactText(value.message));
    copy.name = value.name;
    copy.stack = value.stack ? redactText(value.stack) : undefined;
    return copy as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        SENSITIVE_KEYS.test(k) && v !== undefined && v !== null && v !== ''
          ? MASK
          : redactObject(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

export function maskSecret(secret: string | undefined, visible = 0): string {
  if (!secret) return '';
  if (visible <= 0 || secret.length <= visible * 2) return MASK;
  return `${secret.slice(0, visible)}${MASK}`;
}

/** Shortens a value for display while keeping it recognisable (e.g. env var values). */
export function describeSecretValue(value: string): string {
  if (/^mongodb(\+srv)?:\/\//i.test(value)) return maskConnectionString(value);
  return `${MASK} (${value.length} chars)`;
}
