/**
 * Who can do what on the Deal Desk.
 *
 *  - Salesperson (any CRM user): creates deals, sees and edits their own.
 *  - Reviewer (online sales team, set in Deal Desk settings): picks up,
 *    runs the AI, requests info, approves to F&I.
 *  - Finance Manager (set in settings): receives 5-minute offers, works F&I.
 *  - Manager (CRM manager/admin role or listed in settings): everything,
 *    incl. overrides. Admins also edit settings and the lender matrix.
 *
 * Enforced here at the API — the UI only mirrors it.
 */
import { Request } from 'express';
import { Types } from 'mongoose';
import { ApiError } from '../../utils/ApiError';
import { DealDeskSettings, IDealDeskSettings } from '../../models/DealDeskSupport.model';
import { DEFAULT_SLA_MINUTES } from './constants';

export interface Actor {
  id: string;
  name: string;
  email?: string;
  role: 'employee' | 'manager' | 'admin';
  orgId: string;
}

export interface Roles {
  isAdmin: boolean;
  isManager: boolean;
  isReviewer: boolean;
  isFm: boolean;
  /** Reviewers, FMs and managers see the whole org queue. */
  isStaff: boolean;
}

export function actorFromRequest(req: Request): Actor {
  const u = req.crmUser as any;
  if (!u || !req.orgId) throw new ApiError(401, 'Please sign in to use the Deal Desk.');
  return {
    id: String(u._id),
    name: u.fullName || u.username || u.email || 'User',
    email: u.email,
    role: (['employee', 'manager', 'admin'].includes(u.role) ? u.role : 'employee') as Actor['role'],
    orgId: String(req.orgId),
  };
}

/* Settings are read on nearly every request and every scheduler tick, so
   they get a short in-process cache. Saves invalidate it immediately. */
const settingsCache = new Map<string, { at: number; value: IDealDeskSettings }>();
const SETTINGS_TTL_MS = 10_000;

export async function getSettings(orgId: string): Promise<IDealDeskSettings> {
  const hit = settingsCache.get(orgId);
  if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
  const value = (await DealDeskSettings.findOneAndUpdate(
    { organizationId: new Types.ObjectId(orgId) },
    { $setOnInsert: { organizationId: new Types.ObjectId(orgId) } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )) as IDealDeskSettings;
  settingsCache.set(orgId, { at: Date.now(), value });
  return value;
}

export function invalidateSettings(orgId: string) {
  settingsCache.delete(orgId);
}

export function slaFor(settings: IDealDeskSettings): Record<string, number> {
  return { ...DEFAULT_SLA_MINUTES, ...(settings.slaMinutes || {}) } as Record<string, number>;
}

const inList = (list: unknown[] | undefined, id: string) => !!list?.some((x) => String(x) === id);

export function rolesFor(actor: Actor, settings: IDealDeskSettings): Roles {
  const isAdmin = actor.role === 'admin';
  const isManager = isAdmin || actor.role === 'manager' || inList(settings.managerIds, actor.id);
  const isReviewer = isManager || inList(settings.reviewerIds, actor.id);
  const isFm = inList(settings.financeManagerIds, actor.id);
  return { isAdmin, isManager, isReviewer, isFm, isStaff: isReviewer || isFm || isManager };
}

export function canViewDeal(actor: Actor, roles: Roles, deal: { salesperson?: { id?: unknown }; createdBy?: { id?: unknown } }): boolean {
  if (roles.isStaff) return true;
  return String(deal.salesperson?.id || '') === actor.id || String(deal.createdBy?.id || '') === actor.id;
}

export function assertCanView(actor: Actor, roles: Roles, deal: any) {
  if (!canViewDeal(actor, roles, deal)) throw new ApiError(404, 'Deal not found');
}

export function assertReviewer(roles: Roles) {
  if (!roles.isReviewer) throw new ApiError(403, 'Only the online sales team can do this.');
}

export function assertManager(roles: Roles) {
  if (!roles.isManager) throw new ApiError(403, 'Only a manager can do this.');
}

export function assertAdmin(roles: Roles) {
  if (!roles.isAdmin) throw new ApiError(403, 'Only an admin can change Deal Desk settings.');
}

export async function contextFromRequest(req: Request) {
  const actor = actorFromRequest(req);
  const settings = await getSettings(actor.orgId);
  const roles = rolesFor(actor, settings);
  return { actor, settings, roles };
}
