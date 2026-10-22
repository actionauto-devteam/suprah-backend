import mongoose, { ClientSession } from 'mongoose';
import CrmLocation from '../models/CrmLocation.model';
import type { KnowledgeLocationScope } from '../models/AiKnowledgeEntry.model';
import { ApiError } from '../utils/ApiError';
import { canReviewTraining, trainingRole } from './aiTraining.service';
import type { KnowledgeIssue } from './aiKnowledgeSafety';

export const KNOWLEDGE_LOCATION_LIMIT = 20;
export const KNOWLEDGE_NOTE_MAX = 500;

export const withSession = (session: ClientSession | null) => (session ? { session } : {});
export const isDuplicateKeyError = (err: any) => err?.code === 11000 || /E11000/.test(String(err?.message || ''));

export const canReviewKnowledge = (user: any): boolean => canReviewTraining(trainingRole(user));

export async function activeLocationIds(organizationId: string, session: ClientSession | null = null): Promise<Set<string>> {
  const rows: any[] = await CrmLocation.find({ organizationId, status: 'active' }).select('_id').session(session).lean();
  return new Set(rows.map((row) => String(row._id)));
}

export const activeSuspensions = (suspended: any[] | undefined, active: Set<string>) =>
  (suspended || []).filter((id) => active.has(String(id)));

export function requireKnowledgeReviewer(user: any, message = 'Only managers or admins can review Knowledge Base entries'): void {
  if (!canReviewKnowledge(user)) throw new ApiError(403, message);
}

export function cleanKnowledgeNote(raw: unknown, required: boolean): string | undefined {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new ApiError(400, 'Notes must be text');
  const note = String(raw || '').replace(/\s+/g, ' ').trim();
  if (required && !note) throw new ApiError(400, 'Please add a short note');
  if (note.length > KNOWLEDGE_NOTE_MAX) throw new ApiError(400, `Notes can be at most ${KNOWLEDGE_NOTE_MAX} characters`);
  return note || undefined;
}

export function parseLocationScope(raw: unknown, problems: KnowledgeIssue[], field = 'locations'): KnowledgeLocationScope | undefined {
  if (raw === undefined || raw === null) {
    problems.push({ field, code: 'location_required', message: 'Choose All Locations or at least one specific location.' });
    return undefined;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    problems.push({ field, code: 'invalid_type', message: 'Choose All Locations or at least one specific location.' });
    return undefined;
  }
  const input = raw as { scope?: unknown; locationIds?: unknown };
  if (input.scope === 'all') {
    if (input.locationIds !== undefined && (!Array.isArray(input.locationIds) || input.locationIds.length > 0)) {
      problems.push({ field: `${field}.locationIds`, code: 'ambiguous_scope', message: "All Locations can't also list specific locations." });
    }
    return { scope: 'all', locationIds: [] };
  }
  if (input.scope !== 'locations') {
    problems.push({ field: `${field}.scope`, code: input.scope === undefined ? 'location_required' : 'invalid_value', message: 'Choose All Locations or specific locations.' });
    return undefined;
  }
  if (!Array.isArray(input.locationIds) || input.locationIds.length === 0) {
    problems.push({ field: `${field}.locationIds`, code: 'location_required', message: 'Choose at least one location, or choose All Locations.' });
    return undefined;
  }
  if (input.locationIds.length > KNOWLEDGE_LOCATION_LIMIT) {
    problems.push({ field: `${field}.locationIds`, code: 'too_many', message: `Choose at most ${KNOWLEDGE_LOCATION_LIMIT} locations.` });
    return undefined;
  }
  const ids: mongoose.Types.ObjectId[] = [];
  const seen = new Set<string>();
  input.locationIds.forEach((value, index) => {
    const path = `${field}.locationIds.${index}`;
    if (typeof value !== 'string' && !(value instanceof mongoose.Types.ObjectId)) {
      problems.push({ field: path, code: 'invalid_type', message: 'Each location must be a location id.' });
      return;
    }
    const id = String(value);
    if (!/^[a-f0-9]{24}$/i.test(id)) {
      problems.push({ field: path, code: 'location_not_found', message: 'This location was not found.' });
      return;
    }
    if (seen.has(id.toLowerCase())) {
      problems.push({ field: path, code: 'duplicate_location', message: 'This location is listed more than once.' });
      return;
    }
    seen.add(id.toLowerCase());
    ids.push(new mongoose.Types.ObjectId(id));
  });
  return { scope: 'locations', locationIds: ids };
}

export async function locationIssues(organizationId: string, scope: KnowledgeLocationScope, session: ClientSession | null, field = 'locations'): Promise<KnowledgeIssue[]> {
  if (!scope || scope.scope === 'all') return [];
  const rows: any[] = await CrmLocation.find({ organizationId, _id: { $in: scope.locationIds } })
    .select('status').session(session).lean();
  const byId = new Map(rows.map((row) => [String(row._id), row]));
  return scope.locationIds.flatMap((id, index) => {
    const path = `${field}.locationIds.${index}`;
    const row = byId.get(String(id));
    if (!row) return [{ field: path, code: 'location_not_found', message: 'This location was not found.' }];
    if (row.status !== 'active') return [{ field: path, code: 'location_archived', message: 'This location is archived. Choose an active location.' }];
    return [];
  });
}

export interface EffectiveScope {
  scope: 'all' | 'locations';
  locationIds: any[];
  excludedLocationIds?: any[];
}

type ScopeLike = { scope?: string; locationIds?: any[]; excludedLocationIds?: any[] } | null | undefined;

const idSet = (ids?: any[]) => new Set((ids || []).map(String));

export function effectiveScope(scope: ScopeLike, suspendedIds?: any[]): EffectiveScope | null {
  if (!scope) return null;
  const suspended = idSet(suspendedIds);
  if (scope.scope === 'all') return { scope: 'all', locationIds: [], excludedLocationIds: Array.from(suspended) };
  const ids = (scope.locationIds || []).filter((id) => !suspended.has(String(id)));
  return ids.length ? { scope: 'locations', locationIds: ids } : null;
}

export function scopeIncludesLocation(scope: ScopeLike, locationId: any): boolean {
  if (!scope) return false;
  const id = String(locationId);
  if (scope.scope === 'all') return !idSet(scope.excludedLocationIds).has(id);
  return idSet(scope.locationIds).has(id);
}

export function scopesOverlap(a: ScopeLike, b: ScopeLike): boolean {
  if (!a || !b) return false;
  if (a.scope === 'all' && b.scope === 'all') return true;
  if (a.scope === 'all') return (b.locationIds || []).some((id) => scopeIncludesLocation(a, id));
  if (b.scope === 'all') return (a.locationIds || []).some((id) => scopeIncludesLocation(b, id));
  const left = idSet(a.locationIds);
  return (b.locationIds || []).some((id) => left.has(String(id)));
}

export function scopeCovers(outer: ScopeLike, inner: ScopeLike): boolean {
  if (!outer || !inner) return false;
  if (outer.scope === 'all') {
    const excluded = idSet(outer.excludedLocationIds);
    if (inner.scope === 'all') {
      const innerExcluded = idSet(inner.excludedLocationIds);
      return Array.from(excluded).every((id) => innerExcluded.has(id));
    }
    const needed = (inner.locationIds || []).map(String);
    return needed.length > 0 && needed.every((id) => !excluded.has(id));
  }
  if (inner.scope === 'all') return false;
  const allowed = idSet(outer.locationIds);
  const needed = (inner.locationIds || []).map(String);
  return needed.length > 0 && needed.every((id) => allowed.has(id));
}
