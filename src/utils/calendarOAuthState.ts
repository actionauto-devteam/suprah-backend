import crypto from 'crypto';
import mongoose from 'mongoose';
import { resolveCrmJwtSecret } from './crmJwtSecret';

const STATE_TTL_MS = 15 * 60 * 1000;
const STATE_PURPOSE = 'crm-google-calendar';

function signatureFor(payload: string): string {
  return crypto.createHmac('sha256', resolveCrmJwtSecret()).update(`${STATE_PURPOSE}.${payload}`).digest('base64url');
}

export function signCalendarState(crmUserId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: crmUserId, e: now + STATE_TTL_MS, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${signatureFor(payload)}`;
}

export function readCalendarState(state: unknown, now = Date.now()): string | null {
  if (typeof state !== 'string') return null;
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts;
  const expected = signatureFor(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data?.u !== 'string' || !mongoose.isValidObjectId(data.u)) return null;
    if (typeof data?.e !== 'number' || now > data.e) return null;
    return data.u;
  } catch {
    return null;
  }
}
