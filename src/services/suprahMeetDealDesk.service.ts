import crypto from 'crypto';
import { promisify } from 'util';
import config from '../config';
import logger from '../utils/logger';
import { ApiError } from '../utils/ApiError';
import type { IMeeting } from '../models/Meeting.model';

/* ── Passwords ────────────────────────────────────────────────────────────────
 * Room passwords are stored as scrypt hashes (built into Node — no new
 * dependency). The hash field is `select: false` on the model and is never
 * serialized; only the functions below ever read it. */

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEYLEN = 32;

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 64;

export function validateRoomPassword(raw: unknown): string {
  if (typeof raw !== 'string') throw new ApiError(400, 'Set a password for this Deal Desk room.');
  const pw = raw.trim();
  if (pw.length < PASSWORD_MIN) throw new ApiError(400, `The room password must be at least ${PASSWORD_MIN} characters.`);
  if (pw.length > PASSWORD_MAX) throw new ApiError(400, `The room password can be at most ${PASSWORD_MAX} characters.`);
  return pw;
}

export async function hashRoomPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyRoomPassword(pw: unknown, stored?: string | null): Promise<boolean> {
  if (typeof pw !== 'string' || !pw || !stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(pw.trim(), Buffer.from(saltB64, 'base64'), expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/* ── Password attempt limiting ────────────────────────────────────────────────
 * Per client IP + room. A per-room lockout would let anyone lock real
 * customers out of a rep's room, so the key always includes the IP.
 * In-memory: with several API instances behind a load balancer each keeps its
 * own counters (still bounded). Swap for Redis if you run many instances. */

const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60_000;
const attempts = new Map<string, { failures: number; resetAt: number }>();

function sweep(now: number) {
  if (attempts.size < 5000) return;
  for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
}

export function assertAttemptAllowed(key: string) {
  const now = Date.now();
  const a = attempts.get(key);
  if (a && a.resetAt > now && a.failures >= MAX_FAILURES) {
    const mins = Math.max(1, Math.ceil((a.resetAt - now) / 60_000));
    throw new ApiError(429, `Too many incorrect passwords for this room. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  }
}

/** Returns how many attempts remain in the current window. */
export function recordFailure(key: string): number {
  const now = Date.now();
  sweep(now);
  const a = attempts.get(key);
  const next = a && a.resetAt > now ? { failures: a.failures + 1, resetAt: a.resetAt } : { failures: 1, resetAt: now + WINDOW_MS };
  attempts.set(key, next);
  return Math.max(0, MAX_FAILURES - next.failures);
}

export function clearFailures(key: string) { attempts.delete(key); }

/* ── Presence (read-only) ─────────────────────────────────────────────────────
 * The public page is unauthenticated and polled, so it must never write.
 * These mirror the presence service's notion of "in the room" from the
 * persisted session heartbeats without reconciling anything. */

const SESSION_FRESH_MS = 90_000;
/** A queued customer whose page stopped polling this long ago is flagged. */
export const QUEUE_STALE_MS = 45_000;
/** …and after this long they are dropped from public counts and the in-room banner. */
export const QUEUE_EXPIRED_MS = 3 * 60_000;

export function isActiveParticipant(p: any, now = Date.now()): boolean {
  if (p.leftAt) return false;
  const sessions: any[] = p.sessions ?? [];
  if (sessions.length === 0) return true;
  return sessions.some((s) => s?.lastSeenAt && now - new Date(s.lastSeenAt).getTime() < SESSION_FRESH_MS);
}

export function isQueueEntryLive(w: any, now = Date.now()): boolean {
  if (w.status !== 'waiting') return false;
  if (!w.lastSeenAt) return true; // internal join-by-code requests have no heartbeat
  return now - new Date(w.lastSeenAt).getTime() < QUEUE_EXPIRED_MS;
}

export type DealDeskRoomState = 'available' | 'in_session' | 'away' | 'closed' | 'ended';

export function roomPresence(m: any, now = Date.now()) {
  const hostId = String(m.hostCrmUserId);
  const active = (m.participants ?? []).filter((p: any) => isActiveParticipant(p, now));
  const hostInRoom = active.some((p: any) => p.crmUserId && String(p.crmUserId) === hostId);
  const guestsInRoom = active.filter((p: any) => p.isGuest);
  let state: DealDeskRoomState;
  if (m.status === 'ended') state = 'ended';
  else if (guestsInRoom.length > 0) state = 'in_session';
  else if (!m.dealDesk?.isOpen) state = 'closed';
  else if (hostInRoom) state = 'available';
  else state = 'away';
  return { active, hostInRoom, guestsInRoom, state };
}

export function liveQueue(m: any, now = Date.now()) {
  return ((m.waiting ?? []) as any[])
    .filter((w) => isQueueEntryLive(w, now))
    .sort((a, b) => new Date(a.requestedAt).getTime() - new Date(b.requestedAt).getTime());
}

/* ── Links ──────────────────────────────────────────────────────────────── */

const APP_URL = (process.env.MEET_APP_URL || process.env.APP_URL || config.frontendUrl || '').replace(/\/$/, '');

export function dealDeskUrls(organizationId: string, code?: string) {
  const publicUrl = `${APP_URL}/meet/deal-desk/${encodeURIComponent(organizationId)}`;
  return { publicUrl, roomUrl: code ? `${publicUrl}?room=${encodeURIComponent(code)}` : null };
}

export const stripGuestSuffix = (name: string) => String(name || '').replace(/\s*\(guest\)\s*$/i, '');

/* ── Serializers ──────────────────────────────────────────────────────────── */

/** Public page — no password, no customer names, no emails. */
export function serializePublicRoom(m: any, host: { fullName?: string; avatar?: string | null } | undefined, now = Date.now()) {
  const { state } = roomPresence(m, now);
  return {
    code: m.code,
    title: m.title,
    description: m.dealDesk?.description || null,
    rep: { name: host?.fullName || 'Sales representative', avatar: host?.avatar ?? null },
    state,
    queueLength: liveQueue(m, now).length,
    createdAt: m.createdAt,
  };
}

/** Rep / manager management view. */
export function serializeHostRoom(m: any, host?: { _id?: any; fullName?: string }, now = Date.now()) {
  const { active, hostInRoom, state } = roomPresence(m, now);
  const activeGuestIds = new Set(active.filter((p: any) => p.isGuest).map((p: any) => p.guestId));
  const entries = (m.waiting ?? []) as any[];
  const toId = (w: any) => (w.crmUserId ? String(w.crmUserId) : `guest:${w.guestId}`);
  const queue = liveQueue(m, now).map((w, i) => ({
    id: toId(w),
    position: i + 1,
    fullName: stripGuestSuffix(w.fullName),
    email: w.guestEmail ?? null,
    isGuest: Boolean(w.isGuest),
    requestedAt: w.requestedAt,
    lastSeenAt: w.lastSeenAt ?? null,
    stale: Boolean(w.lastSeenAt && now - new Date(w.lastSeenAt).getTime() > QUEUE_STALE_MS),
  }));
  // Admitted but not (yet / any longer) in the call.
  const admitted = entries
    .filter((w) => w.status === 'admitted' && !(w.guestId && activeGuestIds.has(w.guestId))
      && !(m.participants ?? []).some((p: any) => p.guestId && p.guestId === w.guestId))
    .map((w) => ({ id: toId(w), fullName: stripGuestSuffix(w.fullName), email: w.guestEmail ?? null, respondedAt: w.respondedAt ?? null }));
  const inMeeting = active.map((p: any) => ({
    id: p.crmUserId ? String(p.crmUserId) : `guest:${p.guestId}`,
    fullName: p.fullName,
    isGuest: Boolean(p.isGuest),
    isHost: Boolean(p.crmUserId && String(p.crmUserId) === String(m.hostCrmUserId)),
    joinedAt: p.joinedAt,
  }));
  const served = (m.participants ?? []).filter((p: any) => p.isGuest && !activeGuestIds.has(p.guestId)).length;
  const { roomUrl } = dealDeskUrls(String(m.organizationId), m.code);
  return {
    _id: String(m._id),
    code: m.code,
    title: m.title,
    description: m.dealDesk?.description || null,
    isOpen: Boolean(m.dealDesk?.isOpen),
    status: m.status,
    state,
    hostInRoom,
    host: host ? { id: String(host._id ?? m.hostCrmUserId), fullName: host.fullName ?? '' } : { id: String(m.hostCrmUserId), fullName: '' },
    roomUrl,
    passwordUpdatedAt: m.dealDesk?.passwordUpdatedAt ?? null,
    queue,
    admitted,
    inMeeting,
    servedCount: served,
    declinedCount: entries.filter((w) => w.status === 'denied').length,
    createdAt: m.createdAt,
    startedAt: m.startedAt ?? null,
    endedAt: m.endedAt ?? null,
  };
}

/* ── Notifications ────────────────────────────────────────────────────────── */

/**
 * Push the rep's devices when a new customer joins the line. Best-effort.
 * crmPush.service configures web-push (VAPID) at import time, so it is loaded
 * lazily here — importing the Meet controller must never require push config.
 */
export function notifyHostCustomerQueued(meeting: IMeeting, customerName: string) {
  void (async () => {
    const { CrmPushService } = await import('./crmPush.service');
    await CrmPushService.sendToUsers([String(meeting.hostCrmUserId)], {
      source: 'Suprah Meet',
      title: 'Customer waiting in Deal Desk',
      body: `${customerName} is in line for “${meeting.title}”.`,
      tag: `suprah-meet-dealdesk:${meeting.code}`,
      data: { url: '/crm/suprah-meet/deal-desk', priority: 'high', soundProfile: 'attention' },
    }, { ttlSeconds: 300, timeoutMs: 10_000 });
  })().catch((error: unknown) => {
    logger.error({ error, meetingId: meeting._id }, '[SuprahMeet] Deal Desk queue push failed');
  });
}