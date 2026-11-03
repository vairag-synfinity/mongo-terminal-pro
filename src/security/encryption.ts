import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * AES-256-GCM authenticated encryption. Keys are 32 bytes; when derived from a passphrase,
 * scrypt (N=2^15, r=8, p=1) is used with a random 16-byte salt.
 */

export const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SCRYPT_PARAMS = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

export interface EncryptedPayload {
  iv: string;
  tag: string;
  data: string;
}

export function generateKey(): Buffer {
  return randomBytes(KEY_LENGTH);
}

export function generateSalt(): Buffer {
  return randomBytes(16);
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  if (!passphrase) throw new Error('Passphrase must not be empty');
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LENGTH, SCRYPT_PARAMS);
}

export function encrypt(plaintext: string, key: Buffer, associatedData?: string): EncryptedPayload {
  if (key.length !== KEY_LENGTH) throw new Error('Invalid key length');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (associatedData) cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function decrypt(payload: EncryptedPayload, key: Buffer, associatedData?: string): string {
  if (key.length !== KEY_LENGTH) throw new Error('Invalid key length');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
  if (associatedData) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
  decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new Error('Decryption failed: wrong key/passphrase or the data was tampered with');
  }
}

export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
