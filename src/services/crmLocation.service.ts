import mongoose, { ClientSession } from 'mongoose';
import CrmLocation, { CRM_LOCATION_CODE_PATTERN, CrmLocationActorRef, ICrmLocation } from '../models/CrmLocation.model';
import CrmLocationAudit, { CrmLocationAuditAction, CrmLocationSnapshot } from '../models/CrmLocationAudit.model';
import Lead from '../models/lead.model';
import Vehicle from '../models/Vehicle.model';
import Organization from '../models/Organization.model';
import { ApiError } from '../utils/ApiError';
import { normalizeLocationKey } from '../utils/locationKey';
import { runTrainingWrite } from './aiTraining.service';
import { suspendKnowledgeForLocation } from './aiKnowledgeInvalidation.service';
import { flushKnowledgeAuditMany } from './aiKnowledgeAudit';

export const LOCATION_LIMITS = {
  perOrg: 100,
  codeMin: 2,
  code: 40,
  nameMin: 2,
  name: 80,
  aliases: 20,
  alias: 80,
  suggestions: 200,
  auditRows: 50,
} as const;

export type LocationAccess = 'admin' | 'manager' | 'none';

export interface LocationIssue {
  field: string;
  code: string;
  message: string;
}

export interface LocationInput {
  code?: string;
  name?: string;
  aliases?: string[];
}

const LABEL_PATTERN = /^[\p{L}\p{N} .,'&()#/-]+$/u;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const LINK_PATTERN = /(https?:\/\/|www\.)/i;
const PHONE_PATTERN = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/;
const LONG_NUMBER_PATTERN = /\d{6,}/;
const VIN_PATTERN = /\b[A-HJ-NPR-Z0-9]{17}\b/i;
const RECORD_ID_PATTERN = /\b[a-f0-9]{24}\b/i;
const SUGGESTION_MAX_TIME_MS = 15000;
const CONFLICT_MESSAGE = 'This location was just changed by someone else. Refresh and try again.';

export function locationAccess(user: any): LocationAccess {
  const role = String(user?.role || '');
  if (role === 'admin' || role === 'super_admin') return 'admin';
  if (role === 'manager') return 'manager';
  return 'none';
}

export function locationActor(user: any): CrmLocationActorRef {
  const name = user?.fullName || user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Team member';
  return { userId: String(user?._id || ''), name: String(name).slice(0, 120), role: locationAccess(user) === 'admin' ? 'admin' : 'manager' };
}

export { normalizeLocationKey };

export function locationLabelIssues(field: string, label: string, text: string): LocationIssue[] {
  if (EMAIL_PATTERN.test(text)) return [{ field, code: 'contact_info', message: `${label} can't include an email address.` }];
  if (LINK_PATTERN.test(text)) return [{ field, code: 'contact_info', message: `${label} can't include a link.` }];
  if (VIN_PATTERN.test(text) || RECORD_ID_PATTERN.test(text)) return [{ field, code: 'record_reference', message: `${label} can't include a VIN or a record ID.` }];
  if (PHONE_PATTERN.test(text) || LONG_NUMBER_PATTERN.test(text)) return [{ field, code: 'contact_info', message: `${label} can't include phone numbers or long numbers.` }];
  if (!LABEL_PATTERN.test(text)) return [{ field, code: 'invalid_characters', message: `${label} can only use letters, numbers, spaces and . , ' & ( ) # / -` }];
  if (!normalizeLocationKey(text)) return [{ field, code: 'invalid_characters', message: `${label} needs at least one letter or number.` }];
  return [];
}

function cleanLabel(raw: unknown, field: string, label: string, min: number, max: number, issues: LocationIssue[]): string | undefined {
  if (typeof raw !== 'string') {
    issues.push({ field, code: 'invalid_type', message: `${label} must be text.` });
    return undefined;
  }
  const value = raw.replace(/\s+/g, ' ').trim();
  if (value.length < min) {
    issues.push({ field, code: 'too_short', message: `${label} needs at least ${min} characters.` });
    return undefined;
  }
  if (value.length > max) {
    issues.push({ field, code: 'too_long', message: `${label} can be at most ${max} characters.` });
    return undefined;
  }
  const problems = locationLabelIssues(field, label, value);
  issues.push(...problems);
  return problems.length ? undefined : value;
}

export function parseLocationInput(raw: unknown, mode: 'create' | 'update'): { value: LocationInput; issues: LocationIssue[] } {
  const issues: LocationIssue[] = [];
  const value: LocationInput = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { value, issues: [{ field: 'location', code: 'invalid_type', message: 'The location is missing or malformed.' }] };
  }
  const input = raw as Record<string, unknown>;

  if (input.code !== undefined || mode === 'create') {
    if (typeof input.code !== 'string') {
      issues.push({ field: 'code', code: mode === 'create' ? 'required' : 'invalid_type', message: 'Add a location code.' });
    } else {
      const code = input.code.trim().toLowerCase();
      if (code.length < LOCATION_LIMITS.codeMin || code.length > LOCATION_LIMITS.code) {
        issues.push({ field: 'code', code: 'invalid_length', message: `The code needs ${LOCATION_LIMITS.codeMin} to ${LOCATION_LIMITS.code} characters.` });
      } else if (!CRM_LOCATION_CODE_PATTERN.test(code)) {
        issues.push({ field: 'code', code: 'invalid_format', message: 'The code can only use lowercase letters, numbers and hyphens, and cannot start or end with a hyphen.' });
      } else {
        value.code = code;
      }
    }
  }

  if (input.name !== undefined || mode === 'create') {
    if (input.name === undefined) issues.push({ field: 'name', code: 'required', message: 'Add a location name.' });
    else value.name = cleanLabel(input.name, 'name', 'The location name', LOCATION_LIMITS.nameMin, LOCATION_LIMITS.name, issues);
  }

  if (input.aliases !== undefined) {
    if (!Array.isArray(input.aliases)) {
      issues.push({ field: 'aliases', code: 'invalid_type', message: 'Aliases must be a list.' });
    } else {
      const aliases: string[] = [];
      const seen = new Set<string>();
      input.aliases.forEach((item, index) => {
        if (typeof item === 'string' && !item.trim()) return;
        const alias = cleanLabel(item, `aliases.${index}`, `Alias ${index + 1}`, 1, LOCATION_LIMITS.alias, issues);
        if (!alias) return;
        const key = normalizeLocationKey(alias);
        if (seen.has(key)) return;
        seen.add(key);
        aliases.push(alias);
      });
      if (aliases.length > LOCATION_LIMITS.aliases) {
        issues.push({ field: 'aliases', code: 'too_many', message: `Add at most ${LOCATION_LIMITS.aliases} aliases.` });
      }
      value.aliases = aliases;
    }
  }

  return { value, issues };
}

export function computeAliasKeys(code: string, name: string, aliases: string[]): string[] {
  const keys = [name, code, ...aliases].map(normalizeLocationKey).filter(Boolean);
  return Array.from(new Set(keys));
}

function snapshot(location: { code?: string; name: string; aliases: string[]; status: any }, includeCode = true): CrmLocationSnapshot {
  return { ...(includeCode ? { code: location.code } : {}), name: location.name, aliases: [...(location.aliases || [])], status: location.status };
}

const withSession = (session: ClientSession | null) => (session ? { session } : {});

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000 || /E11000/.test(String(err?.message || ''));
}

async function writeAudit(input: {
  organizationId: string;
  locationId: any;
  action: CrmLocationAuditAction;
  revision: number;
  before?: CrmLocationSnapshot;
  after: CrmLocationSnapshot;
  actor: CrmLocationActorRef;
  session: ClientSession | null;
}) {
  await CrmLocationAudit.create([{
    organizationId: input.organizationId,
    locationId: input.locationId,
    action: input.action,
    revision: input.revision,
    ...(input.before ? { before: input.before } : {}),
    after: input.after,
    actor: input.actor,
  }], withSession(input.session));
}

async function assertNoAliasConflict(organizationId: string, keys: string[], excludeId?: any) {
  const filter: Record<string, unknown> = { organizationId, aliasKeys: { $in: keys } };
  if (excludeId) filter._id = { $ne: excludeId };
  const other: any = await CrmLocation.findOne(filter).select('name code aliasKeys status').lean();
  if (!other) return;
  const shared = keys.find((key) => (other.aliasKeys || []).includes(key)) || keys[0];
  throw new ApiError(409, `"${shared}" is already used by the location ${other.name} (${other.code}${other.status === 'archived' ? ', archived' : ''}).`, [
    { field: 'aliases', code: 'alias_taken', message: `"${shared}" is already used by ${other.name}.` },
  ]);
}

function requireIssuesFree(issues: LocationIssue[]) {
  if (issues.length) throw new ApiError(400, issues[0].message, issues);
}

function requireRevision(expected: unknown, location: ICrmLocation) {
  if (expected === undefined || expected === null || expected === '') throw new ApiError(400, 'expectedRevision is required');
  if (Number(expected) !== location.revision) throw new ApiError(409, CONFLICT_MESSAGE);
}

export async function loadLocation(organizationId: string, id: string): Promise<ICrmLocation> {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Location not found');
  const location = await CrmLocation.findOne({ _id: id, organizationId });
  if (!location) throw new ApiError(404, 'Location not found');
  return location;
}

export async function listLocations(organizationId: string, status: 'active' | 'archived' | 'all') {
  const filter: Record<string, unknown> = { organizationId };
  if (status !== 'all') filter.status = status;
  const [locations, active, archived] = await Promise.all([
    CrmLocation.find(filter).sort({ name: 1, _id: 1 }).lean(),
    CrmLocation.countDocuments({ organizationId, status: 'active' }),
    CrmLocation.countDocuments({ organizationId, status: 'archived' }),
  ]);
  return { locations, counts: { active, archived, total: active + archived } };
}

export async function listLocationAudit(organizationId: string, locationId: any) {
  return CrmLocationAudit.find({ organizationId, locationId }).sort({ createdAt: -1, _id: -1 }).limit(LOCATION_LIMITS.auditRows).lean();
}

export async function createLocation(input: { organizationId: string; user: any; location: unknown }) {
  const { value, issues } = parseLocationInput(input.location, 'create');
  requireIssuesFree(issues);
  const code = value.code as string;
  const name = value.name as string;
  const aliases = value.aliases || [];
  const keys = computeAliasKeys(code, name, aliases);
  const total = await CrmLocation.countDocuments({ organizationId: input.organizationId });
  if (total >= LOCATION_LIMITS.perOrg) throw new ApiError(409, `Your organization already has ${LOCATION_LIMITS.perOrg} locations.`);
  if (await CrmLocation.exists({ organizationId: input.organizationId, code })) {
    throw new ApiError(409, `The code "${code}" is already used by another location.`, [{ field: 'code', code: 'code_taken', message: `The code "${code}" is already used.` }]);
  }
  await assertNoAliasConflict(input.organizationId, keys);
  const actor = locationActor(input.user);
  try {
    return await runTrainingWrite(async (session) => {
      const [location] = await CrmLocation.create([{
        organizationId: input.organizationId, code, name, aliases, aliasKeys: keys, status: 'active', revision: 1, createdBy: actor, updatedBy: actor,
      }], withSession(session));
      await writeAudit({ organizationId: input.organizationId, locationId: location._id, action: 'created', revision: 1, after: snapshot(location), actor, session });
      return location;
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ApiError(409, 'That code, name or alias is already used by another location.');
    throw err;
  }
}

export async function updateLocation(input: { organizationId: string; user: any; id: string; location: unknown; expectedRevision: unknown }) {
  const location = await loadLocation(input.organizationId, input.id);
  requireRevision(input.expectedRevision, location);
  if (location.status === 'archived') throw new ApiError(409, 'Restore this location before editing it.');
  const { value, issues } = parseLocationInput(input.location, 'update');
  if (value.code !== undefined && value.code !== location.code) {
    issues.push({ field: 'code', code: 'code_immutable', message: 'The location code cannot be changed.' });
  }
  requireIssuesFree(issues);
  const name = value.name ?? location.name;
  const aliases = value.aliases ?? location.aliases;
  const keys = computeAliasKeys(location.code, name, aliases);
  const unchanged = name === location.name && JSON.stringify(aliases) === JSON.stringify(location.aliases);
  if (unchanged) return { location, changed: false };
  await assertNoAliasConflict(input.organizationId, keys, location._id);
  const actor = locationActor(input.user);
  const before = snapshot(location, false);
  try {
    const updated = await runTrainingWrite(async (session) => {
      const next = await CrmLocation.findOneAndUpdate(
        { _id: location._id, organizationId: input.organizationId, revision: location.revision, status: 'active' },
        { $set: { name, aliases, aliasKeys: keys, updatedBy: actor }, $inc: { revision: 1 } },
        { new: true, runValidators: true, ...withSession(session) },
      );
      if (!next) throw new ApiError(409, CONFLICT_MESSAGE);
      await writeAudit({ organizationId: input.organizationId, locationId: next._id, action: 'updated', revision: next.revision, before, after: snapshot(next), actor, session });
      return next;
    });
    return { location: updated, changed: true };
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ApiError(409, 'That name or alias is already used by another location.');
    throw err;
  }
}

export async function setLocationArchived(input: { organizationId: string; user: any; id: string; archived: boolean; expectedRevision: unknown }) {
  const location = await loadLocation(input.organizationId, input.id);
  requireRevision(input.expectedRevision, location);
  if ((location.status === 'archived') === input.archived) {
    throw new ApiError(409, input.archived ? 'This location is already archived.' : 'This location is not archived.');
  }
  const actor = locationActor(input.user);
  const before = snapshot(location, false);
  const result = await runTrainingWrite(async (session) => {
    const next = await CrmLocation.findOneAndUpdate(
      { _id: location._id, organizationId: input.organizationId, revision: location.revision },
      {
        $set: input.archived ? { status: 'archived', archivedAt: new Date(), updatedBy: actor } : { status: 'active', archivedAt: null, updatedBy: actor },
        $inc: { revision: 1 },
      },
      { new: true, ...withSession(session) },
    );
    if (!next) throw new ApiError(409, CONFLICT_MESSAGE);
    await writeAudit({
      organizationId: input.organizationId, locationId: next._id, action: input.archived ? 'archived' : 'restored', revision: next.revision, before, after: snapshot(next), actor, session,
    });
    const suspended = await suspendKnowledgeForLocation({
      organizationId: input.organizationId, locationId: next._id, cause: input.archived ? 'location_archived' : 'location_restored', actor, session,
    });
    return { next, suspended };
  });
  await flushKnowledgeAuditMany(input.organizationId, result.suspended);
  return result.next;
}

interface SuggestionBucket {
  key: string;
  labels: Map<string, number>;
  leadCount: number;
  vehicleCount: number;
  inReviewLinks: boolean;
}

export async function suggestLocationLabels(organizationId: string) {
  const buckets = new Map<string, SuggestionBucket>();
  const add = (rawLabel: unknown, source: 'leads' | 'vehicles' | 'reviewLinks', count: number) => {
    if (typeof rawLabel !== 'string') return;
    const label = rawLabel.replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = normalizeLocationKey(label);
    if (!key) return;
    const bucket = buckets.get(key) || { key, labels: new Map(), leadCount: 0, vehicleCount: 0, inReviewLinks: false };
    bucket.labels.set(label, (bucket.labels.get(label) || 0) + count);
    if (source === 'leads') bucket.leadCount += count;
    if (source === 'vehicles') bucket.vehicleCount += count;
    if (source === 'reviewLinks') bucket.inReviewLinks = true;
    buckets.set(key, bucket);
  };

  const leadRows = mongoose.isValidObjectId(organizationId)
    ? await Lead.aggregate([
      { $match: { organizationId: new mongoose.Types.ObjectId(organizationId), location: { $type: 'string', $ne: '' } } },
      { $group: { _id: '$location', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: LOCATION_LIMITS.suggestions },
    ]).option({ maxTimeMS: SUGGESTION_MAX_TIME_MS })
    : [];
  for (const row of leadRows) add(row._id, 'leads', row.count);

  const vehicleRows = await Vehicle.aggregate([
    { $match: { organizationId, isDeleted: { $ne: true }, dealerCity: { $type: 'string', $ne: '' } } },
    { $group: { _id: '$dealerCity', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: LOCATION_LIMITS.suggestions },
  ]).option({ maxTimeMS: SUGGESTION_MAX_TIME_MS });
  for (const row of vehicleRows) add(row._id, 'vehicles', row.count);

  const org: any = mongoose.isValidObjectId(organizationId)
    ? await Organization.findById(organizationId).select('metadata.reviewLinks').lean()
    : null;
  const reviewLinks = Array.isArray(org?.metadata?.reviewLinks) ? org.metadata.reviewLinks : [];
  for (const link of reviewLinks) add(link?.location, 'reviewLinks', 0);

  const locations = await CrmLocation.find({ organizationId }).select('name code status aliasKeys').lean();
  const byKey = new Map<string, any>();
  for (const location of locations as any[]) for (const key of location.aliasKeys || []) byKey.set(key, location);

  const suggestions = Array.from(buckets.values()).map((bucket) => {
    const labels = Array.from(bucket.labels.entries()).sort((a, b) => b[1] - a[1]).map(([label]) => label);
    const label = labels[0];
    const mapped = byKey.get(bucket.key);
    return {
      key: bucket.key,
      label,
      variants: labels.slice(0, 5),
      leadCount: bucket.leadCount,
      vehicleCount: bucket.vehicleCount,
      inReviewLinks: bucket.inReviewLinks,
      usable: locationLabelIssues('label', 'Label', label).length === 0 && label.length <= LOCATION_LIMITS.alias,
      mapped: mapped ? { id: String(mapped._id), name: mapped.name, code: mapped.code, status: mapped.status } : null,
    };
  });
  suggestions.sort((a, b) => {
    if (Boolean(a.mapped) !== Boolean(b.mapped)) return a.mapped ? 1 : -1;
    return (b.leadCount + b.vehicleCount) - (a.leadCount + a.vehicleCount) || a.label.localeCompare(b.label);
  });
  return suggestions.slice(0, LOCATION_LIMITS.suggestions);
}
