/**
 * Field-level encryption for the most sensitive credit-app field (SSN).
 *
 * AES-256-GCM with a key from DEAL_PII_KEY (32 bytes, hex or base64).
 * When the key is not configured we refuse to store the full SSN and keep
 * only the last 4 digits — never plaintext at rest.
 */
import crypto from 'crypto';

let cachedKey: Buffer | null | undefined;

function getKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = (process.env.DEAL_PII_KEY || '').trim();
  if (!raw) {
    cachedKey = null;
    return null;
  }
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('DEAL_PII_KEY must be 32 bytes (64 hex chars or base64)');
  cachedKey = buf;
  return buf;
}

export function piiEncryptionAvailable(): boolean {
  try {
    return !!getKey();
  } catch {
    return false;
  }
}

export function encryptPii(plain: string): string | null {
  const key = getKey();
  if (!key) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptPii(payload?: string | null): string | null {
  if (!payload) return null;
  const key = getKey();
  if (!key) return null;
  const [version, ivB64, tagB64, ctB64] = payload.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !ctB64) return null;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Normalizes "123-45-6789" → "123456789"; returns null if not 9 digits. */
export function normalizeSsn(input?: string | null): string | null {
  const digits = String(input || '').replace(/\D/g, '');
  return digits.length === 9 ? digits : null;
}

export function maskSsn(last4?: string | null): string {
  return last4 ? `•••-••-${last4}` : '';
}
