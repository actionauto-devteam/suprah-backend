import { Request, Response, NextFunction } from 'express';
import pulse from '../services/pulse360.service';
import { PulseSignalType } from '../models/PulseSignal.model';

/**
 * Suprah Pulse360 — passive activity tracking.
 *
 * Mounted once, globally, after authentication. Every authenticated CRM
 * request becomes a candidate signal, which is how Pulse360 gets visibility
 * into Dashboard, Projects, Inventory, Customers, Sales, HR, Finance, Reports,
 * Feeds, Suprah Space, Appointments and anything added later — without a
 * single line of instrumentation inside those controllers.
 *
 * Three protections keep this from becoming a write amplifier:
 *   • GETs are throttled hard per (user, module) — one navigation signal per
 *     module every few minutes, not one per XHR.
 *   • Only 2xx responses are recorded, so failed and rejected calls don't
 *     inflate anyone's engagement.
 *   • Writes are fire-and-forget after the response is sent; the tracker can
 *     never add latency to, or fail, the real request.
 */

const NAVIGATION_THROTTLE_MS = 5 * 60_000;
const MUTATION_THROTTLE_MS = 15_000;

/** In-process throttle. Per-pod is fine: worst case is a few extra rows. */
const lastSeen = new Map<string, number>();

// Keep the map from growing without bound on a long-lived process.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const [key, at] of lastSeen.entries()) {
    if (at < cutoff) lastSeen.delete(key);
  }
}, 10 * 60_000).unref?.();

/**
 * URL segment → human module name. Order matters: the first prefix that
 * matches wins, so more specific paths are listed first.
 */
const MODULE_MAP: Array<[RegExp, string]> = [
  [/^\/api\/crm\/projects/, 'Projects'],
  [/^\/api\/crm\/timeproof/, 'TimeProof'],
  [/^\/api\/crm\/whats-new/, 'What\'s New'],
  [/^\/api\/crm\/aftermarket/, 'Aftermarket'],
  [/^\/api\/crm\/feeds/, 'Feeds'],
  [/^\/api\/crm\/calendar/, 'Calendar'],
  [/^\/api\/crm\/daypulse/, 'Day Pulse'],
  [/^\/api\/crm\/customer-invites/, 'Customers'],
  [/^\/api\/crm\/pulse360/, 'Pulse360'],
  [/^\/api\/crm\/reviews/, 'Reviews'],
  [/^\/api\/crm/, 'CRM'],
  [/^\/api\/mail/, 'Suprah Mail'],
  [/^\/api\/supraspace/, 'Suprah Space'],
  [/^\/api\/deal-board/, 'Sales'],
  [/^\/api\/leads/, 'Leads'],
  [/^\/api\/org-lead/, 'Leads'],
  [/^\/api\/referral-leads/, 'Leads'],
  [/^\/api\/customers/, 'Customers'],
  [/^\/api\/customer-concern/, 'Customers'],
  [/^\/api\/customer-call/, 'Customers'],
  [/^\/api\/vehicles/, 'Inventory'],
  [/^\/api\/auction/, 'Inventory'],
  [/^\/api\/appointments/, 'Appointments'],
  [/^\/api\/schedules/, 'Scheduling'],
  [/^\/api\/team-pulse/, 'Team Engagement'],
  [/^\/api\/timeclock/, 'TimeProof'],
  [/^\/api\/locator/, 'Locator'],
  [/^\/api\/analytics/, 'Reports'],
  [/^\/api\/dashboard/, 'Dashboard'],
  [/^\/api\/payments/, 'Finance'],
  [/^\/api\/wallet/, 'Finance'],
  [/^\/api\/linked-accounts/, 'Finance'],
  [/^\/api\/quotes/, 'Quotes'],
  [/^\/api\/service/, 'Service'],
  [/^\/api\/loads/, 'Transportation'],
  [/^\/api\/driver/, 'Transportation'],
  [/^\/api\/calendar/, 'Calendar'],
];

/** Paths that are pure infrastructure noise and never represent work. */
const IGNORED = [
  /^\/api\/crm\/pulse360\/(me|alerts|overview|users|stream)/,
  /^\/api\/crm\/me$/,
  /^\/api\/crm\/token-refresh/,
  /^\/api\/auth\//,
  /^\/api\/push\//,
  /^\/api\/notifications/,
  /^\/api\/crm\/timeproof\/(shift-state|my-agent|heartbeat)/,
  /^\/api\/timeclock\/(shift-state|me)/,
  /^\/api\/locator\/ping/,
  /health|ping|favicon/,
];

function resolveModule(path: string): string | null {
  for (const [pattern, name] of MODULE_MAP) {
    if (pattern.test(path)) return name;
  }
  return null;
}

/** Turn "POST /api/crm/projects/123/tasks" into a readable timeline entry. */
function describe(method: string, path: string, module: string): string {
  const verb =
    method === 'POST' ? 'Created in' : method === 'DELETE' ? 'Removed in' : method === 'GET' ? 'Worked in' : 'Updated in';
  return `${verb} ${module}`;
}

const pulseTrack = () => (req: Request, res: Response, next: NextFunction) => {
  // Register the listener before handing off, then get out of the way entirely.
  res.on('finish', () => {
    try {
      const crmUser = req.crmUser;
      const orgId = req.orgId ?? crmUser?.organizationId?.toString();
      if (!crmUser || !orgId) return;
      if (res.statusCode < 200 || res.statusCode >= 300) return;

      const path = req.originalUrl.split('?')[0];
      if (IGNORED.some((pattern) => pattern.test(path))) return;

      const module = resolveModule(path);
      if (!module) return;

      const isMutation = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method);
      const key = `${crmUser._id}:${module}:${isMutation ? 'w' : 'r'}`;
      const throttle = isMutation ? MUTATION_THROTTLE_MS : NAVIGATION_THROTTLE_MS;
      const now = Date.now();

      if ((lastSeen.get(key) ?? 0) + throttle > now) return;
      lastSeen.set(key, now);

      const type: PulseSignalType = isMutation ? 'crm.mutation' : 'crm.navigation';

      void pulse.recordSignal({
        organizationId: orgId,
        userId: crmUser._id.toString(),
        department: crmUser.department,
        type,
        module,
        title: describe(req.method, path, module),
        description: `${req.method} ${path}`,
        url: undefined,
        passive: true,
        meta: { method: req.method, path, status: res.statusCode },
      });
    } catch (error) {
      console.error('[PULSE360] passive track failed:', error);
    }
  });

  next();
};

export default pulseTrack;
