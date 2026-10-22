import crypto from 'crypto';
import mongoose, { ClientSession } from 'mongoose';
import AiKnowledgeVerifiedDetail, {
  AiKnowledgeVerifiedDetailRevision,
  VERIFIED_DETAIL_KINDS,
  VERIFIED_DETAIL_STATUSES,
  VERIFIED_PROGRAM_TYPES,
  type VerifiedDetailContent,
  type VerifiedDetailKind,
} from '../models/AiKnowledgeVerifiedDetail.model';
import AiKnowledgeEntry, { type KnowledgeDependency, type KnowledgeLocationScope } from '../models/AiKnowledgeEntry.model';
import AiKnowledgeAuditLog from '../models/AiKnowledgeAuditLog.model';
import AiKnowledgeKeyLock from '../models/AiKnowledgeKeyLock.model';
import { ApiError } from '../utils/ApiError';
import { runTrainingWrite, trainingActor } from './aiTraining.service';
import { EMPTY_BUSINESS_CONTACTS, normalizePhoneDigits, privacyIssues, type BusinessContactSets } from './aiTrainingImportScreening';
import { knowledgeContactValues, normalizeKnowledgeKey, programMentioned, type KnowledgeCheckContext, type KnowledgeIssue } from './aiKnowledgeSafety';
import { invalidateApprovalsForDetail, lockKnowledgeLocations } from './aiKnowledgeInvalidation.service';
import { flushKnowledgeAuditMany, writeKnowledgeAudit } from './aiKnowledgeAudit';
import {
  activeLocationIds,
  activeSuspensions,
  canReviewKnowledge,
  cleanKnowledgeNote,
  effectiveScope,
  isDuplicateKeyError,
  locationIssues,
  parseLocationScope,
  requireKnowledgeReviewer,
  scopeCovers,
  withSession,
} from './aiKnowledgeCommon';

export const DETAIL_LIMITS = { value: 200, label: 80, programMin: 5, program: 80, list: 200 } as const;

const CONTACT_KINDS = new Set<VerifiedDetailKind>(['phone', 'email', 'website']);
const LIVE_STATUSES = ['pending', 'approved'];
const NOT_FOUND = 'Verified detail not found';
const CONFLICT = 'This verified detail was just changed by someone else. Refresh and try again.';
const REVIEWER_MESSAGE = 'Only managers or admins can manage verified business details';
const EMAIL_SHAPE = /^[^\s@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const IP_HOST = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const sha256 = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function cleanText(raw: unknown, field: string, label: string, max: number, required: boolean, problems: KnowledgeIssue[]): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (required) problems.push({ field, code: 'required', message: `${label} is required.` });
    return undefined;
  }
  if (typeof raw !== 'string') {
    problems.push({ field, code: 'invalid_type', message: `${label} must be text.` });
    return undefined;
  }
  const value = raw.replace(/\s+/g, ' ').trim();
  if (!value) {
    if (required) problems.push({ field, code: 'required', message: `${label} is required.` });
    return undefined;
  }
  if (value.length > max) problems.push({ field, code: 'too_long', message: `${label} can be at most ${max} characters.` });
  return value;
}

function normalizeValue(kind: VerifiedDetailKind, value: string, problems: KnowledgeIssue[]): string | undefined {
  if (kind === 'phone') {
    const digits = normalizePhoneDigits(value);
    if (digits.length !== 10 || /[a-z@]/i.test(value)) {
      problems.push({ field: 'value', code: 'invalid_phone', message: 'Enter a 10-digit US phone number.' });
      return undefined;
    }
    return digits;
  }
  if (kind === 'email') {
    if (!EMAIL_SHAPE.test(value)) {
      problems.push({ field: 'value', code: 'invalid_email', message: 'Enter a valid email address.' });
      return undefined;
    }
    return value.toLowerCase();
  }
  if (kind === 'website') {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
      const host = url.hostname.toLowerCase().replace(/^www\./, '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.') || IP_HOST.test(host)) throw new Error('invalid');
      return host;
    } catch {
      problems.push({ field: 'value', code: 'invalid_website', message: 'Enter the dealership website, for example example.com.' });
      return undefined;
    }
  }
  if (value.length < DETAIL_LIMITS.programMin || normalizeKnowledgeKey(value).split(' ').filter(Boolean).length < 2) {
    problems.push({ field: 'value', code: 'program_name', message: 'Give the program a specific name of at least two words, for example "Military Appreciation Program".' });
    return undefined;
  }
  if (/[$%\d]/.test(value)) {
    problems.push({ field: 'value', code: 'program_amount', message: "Program names can't include amounts or numbers." });
    return undefined;
  }
  return normalizeKnowledgeKey(value);
}

export function parseVerifiedDetailInput(body: unknown, fixedKind?: VerifiedDetailKind): VerifiedDetailContent {
  const problems: KnowledgeIssue[] = [];
  const input: Record<string, unknown> = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  let kind = fixedKind;
  if (fixedKind) {
    if (input.kind !== undefined && input.kind !== fixedKind) problems.push({ field: 'kind', code: 'kind_immutable', message: "A detail's type can't be changed. Add a new one instead." });
  } else if (!(VERIFIED_DETAIL_KINDS as readonly unknown[]).includes(input.kind)) {
    problems.push({ field: 'kind', code: input.kind === undefined ? 'required' : 'invalid_value', message: 'Choose phone, email, website or program.' });
  } else {
    kind = input.kind as VerifiedDetailKind;
  }
  const value = cleanText(input.value, 'value', kind === 'program' ? 'The program name' : 'The value', kind === 'program' ? DETAIL_LIMITS.program : DETAIL_LIMITS.value, true, problems);
  const normalizedValue = kind && value ? normalizeValue(kind, value, problems) : undefined;
  const label = cleanText(input.label, 'label', 'The label', DETAIL_LIMITS.label, false, problems);
  if (label && privacyIssues('label', label, { contacts: EMPTY_BUSINESS_CONTACTS, addressSensitive: true, checkNames: false }).some((issue) => issue.severity === 'error')) {
    problems.push({ field: 'label', code: 'label_private', message: "Labels can't include phone numbers, emails, links or other private details." });
  }
  let programType: VerifiedDetailContent['programType'];
  if (kind === 'program') {
    if (!(VERIFIED_PROGRAM_TYPES as readonly unknown[]).includes(input.programType)) {
      problems.push({ field: 'programType', code: input.programType === undefined ? 'required' : 'invalid_value', message: `Choose a program type: ${VERIFIED_PROGRAM_TYPES.join(', ')}.` });
    } else {
      programType = input.programType as VerifiedDetailContent['programType'];
    }
  } else if (input.programType !== undefined) {
    problems.push({ field: 'programType', code: 'not_allowed', message: 'Only programs have a program type.' });
  }
  const locationScope = parseLocationScope(input.locations, problems);
  if (problems.length || !kind || !value || !normalizedValue || !locationScope) throw new ApiError(400, 'Fix the highlighted fields.', problems);
  const content: VerifiedDetailContent = { kind, value, normalizedValue, locationScope };
  if (label) content.label = label;
  if (programType) content.programType = programType;
  return content;
}

function requireRevision(raw: unknown, detail: any): void {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(400, 'Send the revision you are working from.', [{ field: 'expectedRevision', code: 'required', message: 'Send the revision you are working from.' }]);
  }
  if (value !== detail.revision) throw new ApiError(409, CONFLICT);
}

async function loadDetail(organizationId: string, detailId: string, user: any): Promise<any> {
  if (!mongoose.isValidObjectId(detailId)) throw new ApiError(404, NOT_FOUND);
  const filter: Record<string, unknown> = { _id: detailId, organizationId };
  if (!canReviewKnowledge(user)) filter.status = 'approved';
  const detail = await AiKnowledgeVerifiedDetail.findOne(filter).lean();
  if (!detail) throw new ApiError(404, NOT_FOUND);
  return detail;
}

async function lockValue(organizationId: string, kind: string, normalizedValue: string, session: ClientSession | null): Promise<void> {
  await AiKnowledgeKeyLock.updateOne(
    { organizationId, keyHash: sha256(`detail|${kind}|${normalizedValue}`) },
    { $inc: { seq: 1 } },
    { upsert: true, ...withSession(session) },
  );
}

async function assertNoLiveDuplicate(organizationId: string, content: VerifiedDetailContent, excludeId: any, session: ClientSession | null): Promise<void> {
  const other = await AiKnowledgeVerifiedDetail.findOne({
    organizationId,
    kind: content.kind,
    normalizedValue: content.normalizedValue,
    status: { $in: LIVE_STATUSES },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).select('_id status').session(session).lean();
  if (other) {
    throw new ApiError(409, 'This detail is already in the list.', [{ field: 'value', code: 'already_listed', message: 'This detail is already in the list.', detailId: String((other as any)._id) } as any]);
  }
}

function mapWriteError(err: any): never {
  if (isDuplicateKeyError(err)) throw new ApiError(409, CONFLICT);
  throw err;
}

export async function proposeVerifiedDetail(input: { organizationId: string; user: any; body: unknown }): Promise<any> {
  requireKnowledgeReviewer(input.user, REVIEWER_MESSAGE);
  const actor = trainingActor(input.user);
  const content = parseVerifiedDetailInput(input.body);
  const locations = await locationIssues(input.organizationId, content.locationScope, null);
  if (locations.length) throw new ApiError(400, 'Fix the highlighted fields.', locations);
  const detailId = new mongoose.Types.ObjectId();
  try {
    await runTrainingWrite(async (session) => {
      await lockValue(input.organizationId, content.kind, content.normalizedValue, session);
      await assertNoLiveDuplicate(input.organizationId, content, null, session);
      await AiKnowledgeVerifiedDetailRevision.create([{ organizationId: input.organizationId, detailId, revision: 1, ...content, createdBy: actor }], withSession(session));
      await AiKnowledgeVerifiedDetail.create([{ _id: detailId, organizationId: input.organizationId, ...content, status: 'pending', revision: 1, proposedBy: actor }], withSession(session));
      await writeKnowledgeAudit({ organizationId: input.organizationId, action: 'detail_proposed', actor, detailId, version: 1, toStatus: 'pending', session });
    });
  } catch (err) {
    mapWriteError(err);
  }
  return AiKnowledgeVerifiedDetail.findOne({ _id: detailId, organizationId: input.organizationId }).lean();
}

export async function updateVerifiedDetail(input: { organizationId: string; detailId: string; user: any; body: unknown }): Promise<any> {
  requireKnowledgeReviewer(input.user, REVIEWER_MESSAGE);
  const actor = trainingActor(input.user);
  const detail = await loadDetail(input.organizationId, input.detailId, input.user);
  if (!LIVE_STATUSES.includes(detail.status)) throw new ApiError(409, `This detail is ${detail.status} and can't be edited. Add a new one instead.`);
  const body: Record<string, unknown> = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body as Record<string, unknown> : {};
  requireRevision(body.expectedRevision, detail);
  const content = parseVerifiedDetailInput(body, detail.kind);
  const locations = await locationIssues(input.organizationId, content.locationScope, null);
  if (locations.length) throw new ApiError(400, 'Fix the highlighted fields.', locations);
  const nextRevision = detail.revision + 1;
  let touched: string[] = [];
  try {
    touched = await runTrainingWrite(async (session) => {
      await lockValue(input.organizationId, content.kind, content.normalizedValue, session);
      await assertNoLiveDuplicate(input.organizationId, content, detail._id, session);
      await AiKnowledgeVerifiedDetailRevision.create([{ organizationId: input.organizationId, detailId: detail._id, revision: nextRevision, ...content, createdBy: actor }], withSession(session));
      const unset: Record<string, ''> = { approvedBy: '', approvedAt: '' };
      if (!content.label) unset.label = '';
      if (!content.programType) unset.programType = '';
      const updated = await AiKnowledgeVerifiedDetail.findOneAndUpdate(
        { _id: detail._id, organizationId: input.organizationId, revision: detail.revision, status: detail.status },
        { $set: { ...content, status: 'pending', revision: nextRevision, proposedBy: actor }, $unset: unset },
        { new: true, ...withSession(session) },
      ).lean();
      if (!updated) throw new ApiError(409, CONFLICT);
      await writeKnowledgeAudit({
        organizationId: input.organizationId, action: 'detail_updated', actor, detailId: detail._id, version: nextRevision, fromStatus: detail.status, toStatus: 'pending', session,
      });
      return detail.status === 'approved'
        ? invalidateApprovalsForDetail({ organizationId: input.organizationId, detailId: detail._id, reason: 'detail_changed', actor, session })
        : [];
    });
  } catch (err) {
    mapWriteError(err);
  }
  await flushKnowledgeAuditMany(input.organizationId, touched);
  return AiKnowledgeVerifiedDetail.findOne({ _id: detail._id, organizationId: input.organizationId }).lean();
}

export async function approveVerifiedDetail(input: { organizationId: string; detailId: string; user: any; expectedRevision: unknown }): Promise<any> {
  requireKnowledgeReviewer(input.user, REVIEWER_MESSAGE);
  const actor = trainingActor(input.user);
  const detail = await loadDetail(input.organizationId, input.detailId, input.user);
  if (detail.status !== 'pending') throw new ApiError(409, `This detail is ${detail.status} and is not waiting for approval`);
  requireRevision(input.expectedRevision, detail);
  if (detail.proposedBy?.userId === actor.userId) {
    throw new ApiError(403, 'You proposed this detail or its latest change, so another manager or admin needs to approve it.');
  }
  const locations = await locationIssues(input.organizationId, detail.locationScope, null);
  if (locations.length) throw new ApiError(400, 'This detail cannot be approved until the highlighted items are fixed.', locations);
  try {
    await runTrainingWrite(async (session) => {
      await lockValue(input.organizationId, detail.kind, detail.normalizedValue, session);
      await assertNoLiveDuplicate(input.organizationId, detail, detail._id, session);
      const updated = await AiKnowledgeVerifiedDetail.findOneAndUpdate(
        { _id: detail._id, organizationId: input.organizationId, status: 'pending', revision: detail.revision },
        { $set: { status: 'approved', approvedBy: actor, approvedAt: new Date() } },
        { new: true, ...withSession(session) },
      ).lean();
      if (!updated) throw new ApiError(409, CONFLICT);
      await writeKnowledgeAudit({
        organizationId: input.organizationId, action: 'detail_approved', actor, detailId: detail._id, version: detail.revision, fromStatus: 'pending', toStatus: 'approved', session,
      });
    });
  } catch (err) {
    mapWriteError(err);
  }
  return AiKnowledgeVerifiedDetail.findOne({ _id: detail._id, organizationId: input.organizationId }).lean();
}

async function endDetail(input: { organizationId: string; detailId: string; user: any; expectedRevision: unknown; note: unknown; to: 'revoked' | 'archived' }): Promise<any> {
  requireKnowledgeReviewer(input.user, REVIEWER_MESSAGE);
  const actor = trainingActor(input.user);
  const detail = await loadDetail(input.organizationId, input.detailId, input.user);
  const allowed = input.to === 'revoked' ? ['approved'] : ['pending', 'approved', 'revoked'];
  if (!allowed.includes(detail.status)) throw new ApiError(409, `This detail is ${detail.status} and can't be ${input.to}`);
  requireRevision(input.expectedRevision, detail);
  const note = cleanKnowledgeNote(input.note, input.to === 'revoked');
  const stamp = input.to === 'revoked' ? { revokedBy: actor, revokedAt: new Date() } : { archivedBy: actor, archivedAt: new Date() };
  let touched: string[] = [];
  try {
    touched = await runTrainingWrite(async (session) => {
      const updated = await AiKnowledgeVerifiedDetail.findOneAndUpdate(
        { _id: detail._id, organizationId: input.organizationId, status: detail.status, revision: detail.revision },
        { $set: { status: input.to, ...stamp } },
        { new: true, ...withSession(session) },
      ).lean();
      if (!updated) throw new ApiError(409, CONFLICT);
      await writeKnowledgeAudit({
        organizationId: input.organizationId, action: input.to === 'revoked' ? 'detail_revoked' : 'detail_archived', actor, detailId: detail._id,
        version: detail.revision, fromStatus: detail.status, toStatus: input.to, note, session,
      });
      return detail.status === 'approved'
        ? invalidateApprovalsForDetail({ organizationId: input.organizationId, detailId: detail._id, reason: input.to === 'revoked' ? 'detail_revoked' : 'detail_archived', actor, session })
        : [];
    });
  } catch (err) {
    mapWriteError(err);
  }
  await flushKnowledgeAuditMany(input.organizationId, touched);
  return AiKnowledgeVerifiedDetail.findOne({ _id: detail._id, organizationId: input.organizationId }).lean();
}

export const revokeVerifiedDetail = (input: { organizationId: string; detailId: string; user: any; expectedRevision: unknown; note: unknown }) =>
  endDetail({ ...input, to: 'revoked' });

export const archiveVerifiedDetail = (input: { organizationId: string; detailId: string; user: any; expectedRevision: unknown; note?: unknown }) =>
  endDetail({ ...input, note: input.note, to: 'archived' });

export async function reapproveVerifiedDetail(input: { organizationId: string; detailId: string; user: any; expectedRevision: unknown }): Promise<any> {
  requireKnowledgeReviewer(input.user, REVIEWER_MESSAGE);
  const actor = trainingActor(input.user);
  const detail = await loadDetail(input.organizationId, input.detailId, input.user);
  if (detail.status !== 'approved') throw new ApiError(409, `This detail is ${detail.status}. Only approved details can be re-approved for restored locations.`);
  requireRevision(input.expectedRevision, detail);
  if (detail.proposedBy?.userId === actor.userId) {
    throw new ApiError(403, 'You proposed this detail or its latest change, so another manager or admin needs to re-approve it.');
  }
  try {
    await runTrainingWrite(async (session) => {
      await lockKnowledgeLocations(input.organizationId, session);
      const restorable = activeSuspensions(detail.suspendedLocationIds, await activeLocationIds(input.organizationId, session));
      if (!restorable.length) throw new ApiError(409, 'This detail has no suspended locations that are active again.');
      const updated = await AiKnowledgeVerifiedDetail.findOneAndUpdate(
        { _id: detail._id, organizationId: input.organizationId, status: 'approved', revision: detail.revision },
        { $pullAll: { suspendedLocationIds: restorable }, $set: { reapprovedBy: actor, reapprovedAt: new Date() } },
        { new: true, ...withSession(session) },
      ).lean();
      if (!updated) throw new ApiError(409, CONFLICT);
      for (const locationId of restorable) {
        await writeKnowledgeAudit({
          organizationId: input.organizationId, action: 'detail_reapproved', actor, detailId: detail._id, locationId, version: detail.revision, session,
        });
      }
    });
  } catch (err) {
    mapWriteError(err);
  }
  return AiKnowledgeVerifiedDetail.findOne({ _id: detail._id, organizationId: input.organizationId }).lean();
}

export function serializeVerifiedDetail(detail: any, active?: Set<string>) {
  const actor = (ref: any) => (ref ? { name: ref.name, role: ref.role } : undefined);
  const suspended = (detail.suspendedLocationIds || []).map(String);
  const activeSuspended = active ? activeSuspensions(suspended, active).map(String) : suspended;
  return {
    id: String(detail._id),
    kind: detail.kind,
    value: detail.value,
    label: detail.label || undefined,
    programType: detail.programType || undefined,
    locationScope: { scope: detail.locationScope?.scope, locationIds: (detail.locationScope?.locationIds || []).map(String) },
    status: detail.status,
    revision: detail.revision,
    proposedBy: actor(detail.proposedBy),
    approvedBy: actor(detail.approvedBy),
    approvedAt: detail.approvedAt || undefined,
    revokedAt: detail.revokedAt || undefined,
    archivedAt: detail.archivedAt || undefined,
    suspendedLocationIds: suspended,
    needsReapproval: detail.status === 'approved' && activeSuspended.length > 0,
    reapprovedAt: detail.reapprovedAt || undefined,
    updatedAt: detail.updatedAt,
  };
}

export async function listVerifiedDetails(input: { organizationId: string; user: any; query: Record<string, unknown> }) {
  const filter: Record<string, unknown> = { organizationId: input.organizationId };
  const kind = input.query.kind;
  if (kind !== undefined && kind !== '') {
    if (!(VERIFIED_DETAIL_KINDS as readonly unknown[]).includes(kind)) throw new ApiError(400, `kind must be one of: ${VERIFIED_DETAIL_KINDS.join(', ')}`);
    filter.kind = kind;
  }
  const status = input.query.status;
  if (!canReviewKnowledge(input.user)) {
    filter.status = 'approved';
  } else if (status !== undefined && status !== '') {
    if (!(VERIFIED_DETAIL_STATUSES as readonly unknown[]).includes(status)) throw new ApiError(400, `status must be one of: ${VERIFIED_DETAIL_STATUSES.join(', ')}`);
    filter.status = status;
  } else {
    filter.status = { $ne: 'archived' };
  }
  const [rows, active] = await Promise.all([
    AiKnowledgeVerifiedDetail.find(filter).sort({ kind: 1, updatedAt: -1 }).limit(DETAIL_LIMITS.list).lean(),
    activeLocationIds(input.organizationId),
  ]);
  return rows.map((row) => serializeVerifiedDetail(row, active));
}

export async function getVerifiedDetail(input: { organizationId: string; detailId: string; user: any }) {
  const detail = await loadDetail(input.organizationId, input.detailId, input.user);
  const reviewer = canReviewKnowledge(input.user);
  const [revisions, dependents, history] = reviewer
    ? await Promise.all([
      AiKnowledgeVerifiedDetailRevision.find({ organizationId: input.organizationId, detailId: detail._id }).sort({ revision: -1 }).limit(100).lean(),
      AiKnowledgeEntry.find({ organizationId: input.organizationId, 'approvedDependencies.detailId': detail._id }).select('_id status lifecycle approvalInvalidation').limit(200).lean(),
      AiKnowledgeAuditLog.find({ organizationId: input.organizationId, detailId: detail._id }).sort({ createdAt: -1, _id: -1 }).limit(100).lean(),
    ])
    : [[], [], []];
  return {
    detail: serializeVerifiedDetail(detail, await activeLocationIds(input.organizationId)),
    revisions: (revisions as any[]).map((row) => ({
      revision: row.revision,
      value: row.value,
      label: row.label || undefined,
      programType: row.programType || undefined,
      locationScope: { scope: row.locationScope?.scope, locationIds: (row.locationScope?.locationIds || []).map(String) },
      createdBy: row.createdBy ? { name: row.createdBy.name, role: row.createdBy.role } : undefined,
      createdAt: row.createdAt,
    })),
    dependentEntries: (dependents as any[]).map((row) => ({ id: String(row._id), status: row.status, lifecycle: row.lifecycle, invalidated: Boolean(row.approvalInvalidation) })),
    history: (history as any[]).map((row) => ({
      action: row.action, version: row.version || undefined, fromStatus: row.fromStatus || undefined, toStatus: row.toStatus || undefined, note: row.note || undefined,
      actor: row.actor ? { name: row.actor.name, role: row.actor.role } : undefined, createdAt: row.createdAt,
    })),
  };
}

function contactSets(details: any[]): BusinessContactSets {
  const sets: BusinessContactSets = { phones: new Set(), emails: new Set(), domains: new Set() };
  for (const detail of details) {
    if (detail.kind === 'phone') sets.phones.add(detail.normalizedValue);
    else if (detail.kind === 'email') sets.emails.add(detail.normalizedValue);
    else if (detail.kind === 'website') sets.domains.add(detail.normalizedValue);
  }
  return sets;
}

export async function knowledgeSaveContext(organizationId: string): Promise<KnowledgeCheckContext> {
  const rows = await AiKnowledgeVerifiedDetail.find({ organizationId, status: { $in: LIVE_STATUSES }, kind: { $in: Array.from(CONTACT_KINDS) } })
    .select('kind normalizedValue').limit(1000).lean();
  return { contacts: contactSets(rows) };
}

export async function knowledgeReviewContext(organizationId: string, scope: KnowledgeLocationScope, session: ClientSession | null): Promise<{ context: KnowledgeCheckContext; details: any[] }> {
  const rows = await AiKnowledgeVerifiedDetail.find({ organizationId, status: 'approved' })
    .select('kind normalizedValue revision locationScope suspendedLocationIds').limit(1000).session(session).lean();
  const active = await activeLocationIds(organizationId, session);
  const details = (rows as any[]).filter((row) => scopeCovers(effectiveScope(row.locationScope, activeSuspensions(row.suspendedLocationIds, active)), scope));
  return {
    details,
    context: { contacts: contactSets(details), programNames: details.filter((row) => row.kind === 'program').map((row) => row.normalizedValue) },
  };
}

export function matchKnowledgeDependencies(content: { title?: string; question?: string; answer?: string }, details: any[]): KnowledgeDependency[] {
  const text = [content.title, content.question, content.answer].filter(Boolean).join('\n');
  const values = knowledgeContactValues(text);
  const domains = Array.from(values.domains);
  return details
    .filter((detail) => {
      if (detail.kind === 'phone') return values.phones.has(detail.normalizedValue);
      if (detail.kind === 'email') return values.emails.has(detail.normalizedValue);
      if (detail.kind === 'website') return domains.some((domain) => domain === detail.normalizedValue || domain.endsWith(`.${detail.normalizedValue}`));
      return programMentioned(text, [detail.normalizedValue]);
    })
    .map((detail) => ({ detailId: detail._id, revision: detail.revision }));
}

export async function lockKnowledgeDependencies(organizationId: string, dependencies: KnowledgeDependency[], session: ClientSession | null): Promise<void> {
  for (const dependency of dependencies) {
    const result = await AiKnowledgeVerifiedDetail.updateOne(
      { _id: dependency.detailId, organizationId, status: 'approved', revision: dependency.revision },
      { $inc: { lockSeq: 1 } },
      { timestamps: false, ...withSession(session) },
    );
    if (!result.matchedCount) throw new ApiError(409, 'A verified business detail this answer uses just changed. Refresh and try again.');
  }
}
