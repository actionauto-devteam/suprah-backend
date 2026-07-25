import crypto from 'crypto';

// Shared last-mile normalization for every outgoing web push payload,
// applied once at the actual dispatch layer (unifiedPush.service.ts,
// crmPush.service.ts, jobs/push.worker.ts) so it covers every notification
// regardless of which caller built it — no per-call-site changes needed.
const MAX_BODY_LENGTH = 150;

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
