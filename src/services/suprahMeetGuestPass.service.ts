import { Request } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import { ApiError } from '../utils/ApiError';

/**
 * Guest passes — signed JWTs that scope an external guest (no Suprah account)
 * to ONE meeting code. Shared by the guest endpoints and Deal Desk.
 *
 * `dealDesk: true` is only ever set after the room password was verified on
 * the server. Deal Desk rooms refuse guest passes without it, so the room
 * password cannot be bypassed through the plain /meet/<code> guest link.
 */
export const GUEST_SECRET =
  process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || config.jwt.crmJwtSecret || config.jwt.accessSecret;

export interface GuestPass {
  guest: true;
  code: string;
  guestId: string;
  name: string;
  email: string | null;
  organizationId: string;
  dealDesk?: boolean;
}

export const signGuest = (p: Omit<GuestPass, 'guest'>) =>
  jwt.sign({ guest: true, ...p }, GUEST_SECRET, { expiresIn: '12h' });

function rawBearer(req: Request) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
}

function decode(raw: string): GuestPass {
  const p = jwt.verify(raw, GUEST_SECRET) as any;
  if (!p?.guest || !p?.guestId || !p?.code || !p?.organizationId) throw new Error('not a guest pass');
  return p as GuestPass;
}

/** Throws 401 when the pass is missing or invalid. */
export function verifyGuest(req: Request): GuestPass {
  const raw = rawBearer(req);
  if (!raw) throw new ApiError(401, 'Missing guest pass.');
  try {
    return decode(raw);
  } catch {
    throw new ApiError(401, 'Your guest pass is invalid or expired. Re-enter your name to get a new one.');
  }
}

/** Non-throwing variant for public endpoints that answer "expired" instead of 401. */
export function readGuestPass(req: Request): GuestPass | null {
  const raw = rawBearer(req);
  if (!raw) return null;
  try { return decode(raw); } catch { return null; }
}
