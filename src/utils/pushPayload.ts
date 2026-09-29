import crypto from 'crypto';

// Shared last-mile normalization for every outgoing web push payload,
// applied once at the actual dispatch layer (unifiedPush.service.ts,
// crmPush.service.ts, jobs/push.worker.ts) so it covers every notification
// regardless of which caller built it — no per-call-site changes needed.
const MAX_BODY_LENGTH = 150;

const AVATAR_FALLBACK_COLORS = [
  ['#075985', '#f0f9ff'],
  ['#3730a3', '#eef2ff'],
  ['#9f1239', '#fff1f2'],
  ['#166534', '#f0fdf4'],
  ['#9a3412', '#fff7ed'],
  ['#6b21a8', '#faf5ff'],
] as const;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createPushAvatarFallback(identity: string, displayName?: string): string {
  const normalizedIdentity = String(identity || displayName || 'suprah').trim();
  const initials = String(displayName || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'S';
  const [background, foreground] = AVATAR_FALLBACK_COLORS[stableHash(normalizedIdentity) % AVATAR_FALLBACK_COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="48" fill="${background}"/><text x="48" y="58" text-anchor="middle" font-family="Arial,sans-serif" font-size="34" font-weight="700" fill="${foreground}">${initials.replace(/[&<>]/g, '')}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// Browsers/OSes don't reliably ellipsize an overlong notification body
// themselves (some hard-clip mid-word) — truncate here so it always ends
// cleanly instead.
export function truncatePushBody(body: string, maxLength = MAX_BODY_LENGTH): string {
  if (!body || body.length <= maxLength) return body;
  return `${body.slice(0, maxLength - 3).trimEnd()}...`;
}

/**
 * The payload's `tag` field only controls how a notification DISPLAYS once
 * delivered (same-tag replaces in the tray, silently, since renotify defaults
 * false) — it does nothing to stop the push SERVICE (FCM/Mozilla autopush/
 * etc.) from queueing every single push sent while a device is offline and
 * delivering the whole backlog in a burst the moment it reconnects. That
 * burst — the service worker firing `showNotification()` many times in rapid
 * succession as it processes each queued push — is what actually produces a
 * "machine gunned with notifications" experience after being away for a
 * while, even though the FINAL tray state (thanks to `tag`) is correct.
 *
 * The Web Push protocol's `Topic` header is the real fix: sending a new push
 * with the same topic REPLACES any still-undelivered push already queued for
 * that subscription+topic, so only the latest ever reaches the device.
 *
 * Deliberately kept SEPARATE from `tag` rather than derived from it: `tag`
 * often falls back to a broad category (e.g. `'crm'`) for types that were
 * never meant to collapse into each other — a new lead and an unrelated task
 * reminder are both `category: 'crm'` but are NOT the same event, and must
 * never silently discard one of them at the push-service level just because
 * they share a coarse tag. `topic` is only ever set explicitly, at call
 * sites that intend real collapsing: the same dedupeKey (repeat
 * idle/geofence/shift-alert for the SAME subject), or the same SupraSpace
 * conversation / Pulse360 alert.
 */
export function deriveWebPushTopic(topic: string): string {
  return crypto.createHash('sha256').update(topic).digest('base64url').slice(0, 32);
}

interface RawPushPayload {
  title?: string;
  body?: string;
  // Short human label for where this notification is from (e.g. "SupraSpace",
  // "CRM", "Driver Tracker") — prefixed onto the title so the OS notification
  // itself indicates its source, not just the in-app inbox. Never sent as-is
  // to the browser; folded into `title` and stripped.
  source?: string;
  // Opt-in only (see deriveWebPushTopic doc above) — never sent to the
  // browser; hashed and returned separately for the caller to pass as the
  // Web Push `topic` option.
  topic?: string;
  [key: string]: unknown;
}

export function normalizePushPayload(payload: RawPushPayload): { payload: Record<string, unknown>; topic?: string } {
  if (!payload || typeof payload !== 'object') return { payload };
  const { source, topic, ...rest } = payload;

  if (typeof rest.body === 'string') {
    rest.body = truncatePushBody(rest.body as string);
  }
  if (source && typeof rest.title === 'string' && !rest.title.startsWith(`${source} `)) {
    rest.title = `${source} • ${rest.title}`;
  }

  return { payload: rest, topic: topic ? deriveWebPushTopic(topic) : undefined };
}
