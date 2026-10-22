import crypto from 'crypto';
import mongoose, { ClientSession } from 'mongoose';
import AiKnowledgeEntry, {
  KNOWLEDGE_BASE_TOPICS,
  KNOWLEDGE_CHANNELS,
  KNOWLEDGE_ENTRY_KINDS,
  KNOWLEDGE_ENTRY_LIFECYCLES,
  KNOWLEDGE_ENTRY_STATUSES,
  KNOWLEDGE_SOURCE_SYSTEMS,
  type KnowledgeChannel,
  type KnowledgeEntryKind,
  type KnowledgeEntryStatus,
  type KnowledgeLocationScope,
  type KnowledgeSource,
} from '../models/AiKnowledgeEntry.model';
import AiKnowledgeEntryVersion, { type KnowledgeEntryContent } from '../models/AiKnowledgeEntryVersion.model';
import AiKnowledgeAuditLog from '../models/AiKnowledgeAuditLog.model';
import AiKnowledgeKeyLock from '../models/AiKnowledgeKeyLock.model';
import Organization from '../models/Organization.model';
import CrmLocation from '../models/CrmLocation.model';
import AiTrainingImportItem from '../models/AiTrainingImportItem.model';
import AiTrainingImportBatch from '../models/AiTrainingImportBatch.model';
import type { TrainingActorRef } from '../models/AiTrainingPolicy.model';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { runTrainingWrite, trainingActor, trainingRole } from './aiTraining.service';
import { knowledgeContentCheck, normalizeKnowledgeKey, privacyErrors, type KnowledgeCheck, type KnowledgeCheckContext, type KnowledgeIssue } from './aiKnowledgeSafety';
import { flushKnowledgeAudit, knowledgeAuditEntry } from './aiKnowledgeAudit';
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
  scopeIncludesLocation,
  scopesOverlap,
  withSession,
  type EffectiveScope,
} from './aiKnowledgeCommon';
import { lockKnowledgeLocations } from './aiKnowledgeInvalidation.service';
import { knowledgeReviewContext, knowledgeSaveContext, lockKnowledgeDependencies, matchKnowledgeDependencies } from './aiKnowledgeVerifiedDetails.service';

export { canReviewKnowledge, locationIssues, normalizeKnowledgeKey, scopesOverlap };

export const KNOWLEDGE_LIMITS = {
  title: 120,
  titleMin: 2,
  question: 300,
  questionMin: 5,
  answer: 1000,
  answerMin: 2,
  note: 500,
  search: 100,
  conflictScan: 50,
  auditRows: 100,
} as const;

const CONFLICT_MESSAGE = 'This entry was just changed by someone else. Refresh and try again.';
const STALE_MESSAGE = 'This entry has a newer version. Refresh and review the latest version.';
const NOT_FOUND_MESSAGE = 'Knowledge Base entry not found';
const MISSING_VERSION_MESSAGE = 'This entry has a data problem: its current version is missing. Nothing was changed.';
const OVERLAP_MESSAGE = 'Another approved entry already covers this for an overlapping location. Disable it or narrow the locations first.';
const EDITABLE_STATUSES: KnowledgeEntryStatus[] = ['draft', 'changes_requested', 'approved', 'rejected'];

export function isKnowledgeBaseEnabled(): boolean {
  return process.env.AI_KNOWLEDGE_BASE_ENABLED === 'true';
}

export async function resolveKnowledgeBaseAvailability(organizationId: string) {
  const serverEnabled = isKnowledgeBaseEnabled();
  const org: any = await Organization.findById(organizationId).select('metadata.aiKnowledgeBaseEnabled').lean();
  const orgEnabled = org?.metadata?.aiKnowledgeBaseEnabled === true;
  return { serverEnabled, orgEnabled, enabled: serverEnabled && orgEnabled };
}

export function requireKnowledgeBaseServer(): void {
  if (!isKnowledgeBaseEnabled()) throw new ApiError(404, 'The Knowledge Base is not available.');
}

export async function requireKnowledgeBaseEnabled(organizationId: string): Promise<void> {
  requireKnowledgeBaseServer();
  const availability = await resolveKnowledgeBaseAvailability(organizationId);
  if (!availability.orgEnabled) throw new ApiError(409, 'The Knowledge Base is turned off for this organization. An admin can turn it on in settings.');
}

const sha256 = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function effectiveApprovedScope(entry: any): EffectiveScope | null {
  return effectiveScope(entry?.approvedLocationScope, entry?.approvalSuspendedLocationIds);
}

export function needsReapproval(entry: any, active?: Set<string>): boolean {
  const suspended = active ? activeSuspensions(entry?.approvalSuspendedLocationIds, active) : entry?.approvalSuspendedLocationIds || [];
  return Number(entry?.approvedVersion || 0) >= 1 && (Boolean(entry?.approvalInvalidation) || suspended.length > 0);
}

export function isEligibleAt(entry: any, locationId: any): boolean {
  return isRuntimeEligible(entry) && scopeIncludesLocation(effectiveApprovedScope(entry), locationId);
}

export type KnowledgeApprovalState = 'not_approved' | 'valid' | 'partial' | 'suspended' | 'invalidated' | 'disabled' | 'archived';

export function knowledgeApprovalState(entry: any, active?: Set<string>): KnowledgeApprovalState {
  if (!(Number(entry?.approvedVersion || 0) >= 1)) return 'not_approved';
  if (entry.lifecycle === 'archived') return 'archived';
  if (entry.lifecycle === 'disabled') return 'disabled';
  if (entry.approvalInvalidation) return 'invalidated';
  if (!effectiveApprovedScope(entry)) return 'suspended';
  const suspended = active ? activeSuspensions(entry.approvalSuspendedLocationIds, active) : entry.approvalSuspendedLocationIds || [];
  return suspended.length ? 'partial' : 'valid';
}

export function isRuntimeEligible(entry: any): boolean {
  return entry?.lifecycle === 'active'
    && Number(entry?.approvedVersion || 0) >= 1
    && !entry?.approvalInvalidation
    && Boolean(effectiveApprovedScope(entry));
}

export function knowledgeKey(content: { kind: string; topic: string; title: string; question?: string }): string {
  return content.kind === 'faq'
    ? normalizeKnowledgeKey(content.question)
    : `${content.topic}:${normalizeKnowledgeKey(content.title)}`;
}

function textField(raw: unknown, field: string, label: string, limits: { required: boolean; min: number; max: number; multiline?: boolean }, problems: KnowledgeIssue[]): string | undefined {
  if (raw === undefined || raw === null || raw === '') {
    if (limits.required) problems.push({ field, code: 'required', message: `${label} is required.` });
    return undefined;
  }
  if (typeof raw !== 'string') {
    problems.push({ field, code: 'invalid_type', message: `${label} must be text.` });
    return undefined;
  }
  const value = limits.multiline
    ? raw.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
    : raw.replace(/\s+/g, ' ').trim();
  if (!value) {
    if (limits.required) problems.push({ field, code: 'required', message: `${label} is required.` });
    return undefined;
  }
  if (value.length < limits.min) problems.push({ field, code: 'too_short', message: `${label} needs at least ${limits.min} characters.` });
  if (value.length > limits.max) problems.push({ field, code: 'too_long', message: `${label} can be at most ${limits.max} characters.` });
  return value;
}

function parseChannels(raw: unknown, problems: KnowledgeIssue[]): KnowledgeChannel[] {
  if (raw === undefined || raw === null) return [...KNOWLEDGE_CHANNELS];
  if (!Array.isArray(raw) || raw.length === 0) {
    problems.push({ field: 'channels', code: 'invalid_value', message: 'Choose at least one channel: SMS, webchat or email.' });
    return [];
  }
  const channels: KnowledgeChannel[] = [];
  raw.forEach((value, index) => {
    if (!(KNOWLEDGE_CHANNELS as readonly unknown[]).includes(value)) {
      problems.push({ field: `channels.${index}`, code: 'invalid_value', message: 'Channels can be SMS, webchat or email.' });
    } else if (!channels.includes(value as KnowledgeChannel)) {
      channels.push(value as KnowledgeChannel);
    }
  });
  return channels;
}

function titleFromQuestion(question: string): string {
  return question.length > KNOWLEDGE_LIMITS.title ? `${question.slice(0, KNOWLEDGE_LIMITS.title - 1)}…` : question;
}

export function parseKnowledgeInput(body: unknown, fixedKind?: KnowledgeEntryKind): { content: KnowledgeEntryContent; changeNote?: string } {
  const problems: KnowledgeIssue[] = [];
  const input: Record<string, unknown> = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  let kind = fixedKind;
  if (fixedKind) {
    if (input.kind !== undefined && input.kind !== fixedKind) {
      problems.push({ field: 'kind', code: 'kind_immutable', message: "An entry's type can't be changed. Create a new entry instead." });
    }
  } else if (!(KNOWLEDGE_ENTRY_KINDS as readonly unknown[]).includes(input.kind)) {
    problems.push({ field: 'kind', code: input.kind === undefined ? 'required' : 'invalid_value', message: 'Choose FAQ or business information.' });
  } else {
    kind = input.kind as KnowledgeEntryKind;
  }
  const topic = input.topic;
  if (!(KNOWLEDGE_BASE_TOPICS as readonly unknown[]).includes(topic)) {
    problems.push({ field: 'topic', code: topic === undefined ? 'required' : 'invalid_value', message: `Choose a topic: ${KNOWLEDGE_BASE_TOPICS.join(', ')}.` });
  }
  const question = textField(input.question, 'question', 'The question', { required: kind === 'faq', min: KNOWLEDGE_LIMITS.questionMin, max: KNOWLEDGE_LIMITS.question }, problems);
  let title = textField(input.title, 'title', 'The title', { required: kind === 'business_info', min: KNOWLEDGE_LIMITS.titleMin, max: KNOWLEDGE_LIMITS.title }, problems);
  if (!title && question) title = titleFromQuestion(question);
  const answer = textField(input.answer, 'answer', 'The answer', { required: true, min: KNOWLEDGE_LIMITS.answerMin, max: KNOWLEDGE_LIMITS.answer, multiline: true }, problems);
  const channels = parseChannels(input.channels, problems);
  const locationScope = parseLocationScope(input.locations, problems);
  const changeNote = textField(input.changeNote, 'changeNote', 'The change note', { required: false, min: 1, max: KNOWLEDGE_LIMITS.note }, problems);
  if (problems.length || !kind || !title || !answer || !locationScope) {
    throw new ApiError(400, 'Fix the highlighted fields.', problems);
  }
  const content: KnowledgeEntryContent = { kind, topic: topic as KnowledgeEntryContent['topic'], title, answer, channels, locationScope };
  if (question) content.question = question;
  return { content, changeNote };
}

function contentAsInput(content: any): Record<string, unknown> {
  return {
    kind: content?.kind,
    topic: content?.topic,
    title: content?.title,
    question: content?.question,
    answer: content?.answer,
    channels: content?.channels,
    locations: content?.locationScope
      ? { scope: content.locationScope.scope, ...(content.locationScope.scope === 'locations' ? { locationIds: (content.locationScope.locationIds || []).map(String) } : {}) }
      : undefined,
  };
}

function storedContentProblems(content: any): KnowledgeIssue[] {
  if (!(KNOWLEDGE_ENTRY_KINDS as readonly unknown[]).includes(content?.kind)) {
    return [{ field: 'kind', code: 'invalid_value', message: 'This version has an unknown entry type.' }];
  }
  try {
    parseKnowledgeInput(contentAsInput(content), content?.kind);
    return [];
  } catch (err: any) {
    return Array.isArray(err?.errors) ? err.errors : [{ field: 'content', code: 'invalid', message: 'This version is incomplete.' }];
  }
}

async function reviewCheck(organizationId: string, content: any, session: ClientSession | null): Promise<{ blockers: KnowledgeIssue[]; check: KnowledgeCheck; details: any[] }> {
  const shape = storedContentProblems(content);
  if (shape.length) return { blockers: shape, check: { errors: shape, warnings: [] }, details: [] };
  const { context, details } = await knowledgeReviewContext(organizationId, content.locationScope, session);
  const check = knowledgeContentCheck(content, context);
  const locations = await locationIssues(organizationId, content.locationScope, session);
  return { blockers: [...check.errors, ...locations], check: { errors: [...check.errors, ...locations], warnings: check.warnings }, details };
}

export async function knowledgeStorableIssues(organizationId: string, content: KnowledgeEntryContent, context?: KnowledgeCheckContext): Promise<{ locations: KnowledgeIssue[]; privacy: KnowledgeIssue[] }> {
  const locations = await locationIssues(organizationId, content.locationScope, null);
  if (locations.length) return { locations, privacy: [] };
  return { locations, privacy: privacyErrors(knowledgeContentCheck(content, context || await knowledgeSaveContext(organizationId))) };
}

async function requireStorable(organizationId: string, content: KnowledgeEntryContent): Promise<void> {
  const { locations, privacy } = await knowledgeStorableIssues(organizationId, content);
  if (locations.length) throw new ApiError(400, 'Fix the highlighted fields.', locations);
  if (privacy.length) throw new ApiError(400, 'Remove personal or private details before saving.', privacy);
}

export function knowledgeVisibilityFilter(organizationId: string, user: any): Record<string, unknown> {
  const filter: Record<string, unknown> = { organizationId };
  if (!canReviewKnowledge(user)) filter['createdBy.userId'] = String(user?._id || '');
  return filter;
}

async function loadVisibleEntry(organizationId: string, entryId: string, user: any): Promise<any> {
  if (!mongoose.isValidObjectId(entryId)) throw new ApiError(404, NOT_FOUND_MESSAGE);
  const entry = await AiKnowledgeEntry.findOne({ _id: entryId, ...knowledgeVisibilityFilter(organizationId, user) }).lean();
  if (!entry) throw new ApiError(404, NOT_FOUND_MESSAGE);
  return entry;
}

function requireExpectedVersion(raw: unknown, entry: any): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1) {
    throw new ApiError(400, 'Send the version you are working from.', [{ field: 'expectedVersion', code: 'required', message: 'Send the version you are working from.' }]);
  }
  if (value !== entry.currentVersion) throw new ApiError(409, STALE_MESSAGE);
  return value;
}

function requireActive(entry: any, action: string): void {
  if (entry.lifecycle === 'archived') throw new ApiError(409, `Archived entries can't be ${action}.`);
  if (entry.lifecycle !== 'active') throw new ApiError(409, `Disabled entries can't be ${action}. Turn the entry back on first.`);
}

function headFields(content: KnowledgeEntryContent): { set: Record<string, unknown>; unset: Record<string, ''> } {
  const set: Record<string, unknown> = {
    topic: content.topic,
    title: content.title,
    questionKey: knowledgeKey(content),
    channels: content.channels,
    locationScope: content.locationScope,
  };
  const unset: Record<string, ''> = {};
  if (content.question) set.question = content.question;
  else unset.question = '';
  return { set, unset };
}

async function lockKnowledgeKey(organizationId: string, kind: string, key: string, session: ClientSession | null): Promise<void> {
  await AiKnowledgeKeyLock.updateOne(
    { organizationId, keyHash: sha256(`${kind}|${key}`) },
    { $inc: { seq: 1 } },
    { upsert: true, ...withSession(session) },
  );
}

async function approvedConflicts(organizationId: string, entryId: any, kind: string, key: string, scope: KnowledgeLocationScope | EffectiveScope, session: ClientSession | null): Promise<string[]> {
  const rows: any[] = await AiKnowledgeEntry.find({
    organizationId,
    kind,
    approvedKey: key,
    lifecycle: 'active',
    approvedVersion: { $gte: 1 },
    approvalInvalidation: { $exists: false },
    ...(entryId ? { _id: { $ne: entryId } } : {}),
  }).select('_id approvedLocationScope approvalSuspendedLocationIds').limit(KNOWLEDGE_LIMITS.conflictScan).session(session).lean();
  return rows.filter((row) => scopesOverlap(scope, effectiveApprovedScope(row))).map((row) => String(row._id));
}

async function possibleDuplicates(organizationId: string, entryId: any, kind: string, key: string, scope: KnowledgeLocationScope) {
  const rows: any[] = await AiKnowledgeEntry.find({
    organizationId,
    kind,
    questionKey: key,
    lifecycle: { $ne: 'archived' },
    ...(entryId ? { _id: { $ne: entryId } } : {}),
  }).select('_id status lifecycle locationScope').limit(KNOWLEDGE_LIMITS.conflictScan).lean();
  return rows.filter((row) => scopesOverlap(scope, row.locationScope)).map((row) => ({ id: String(row._id), status: row.status, lifecycle: row.lifecycle }));
}

const overlapIssue = (kind: string, entryIds: string[]) => ({
  field: kind === 'faq' ? 'question' : 'title',
  code: 'knowledge_conflict',
  message: OVERLAP_MESSAGE,
  entryIds,
});

function mapWriteError(err: any): never {
  if (isDuplicateKeyError(err)) throw new ApiError(409, CONFLICT_MESSAGE);
  throw err;
}

export async function setOrganizationKnowledgeBaseEnabled(input: { organizationId: string; user: any; enabled: unknown; reason?: unknown }) {
  const actor = trainingActor(input.user);
  if (trainingRole(input.user) !== 'admin') throw new ApiError(403, 'Only admins can turn the Knowledge Base on or off');
  if (typeof input.enabled !== 'boolean') throw new ApiError(400, 'enabled must be true or false');
  const reason = cleanKnowledgeNote(input.reason, false);
  const org: any = await Organization.findById(input.organizationId).select('metadata').lean();
  if (!org) throw new ApiError(404, 'Organization not found');
  const current = org.metadata?.aiKnowledgeBaseEnabled === true;
  if (current === input.enabled) return { changed: false };
  const claimed = await Organization.findOneAndUpdate(
    { _id: input.organizationId, 'metadata.aiKnowledgeBaseEnabled': current ? true : { $ne: true } },
    { $set: { 'metadata.aiKnowledgeBaseEnabled': input.enabled } },
  );
  if (!claimed) throw new ApiError(409, 'Someone else just changed this setting. Refresh and try again.');
  try {
    await AiKnowledgeAuditLog.create({
      organizationId: input.organizationId,
      action: input.enabled ? 'knowledge_base_enabled' : 'knowledge_base_disabled',
      actor,
      fromStatus: current ? 'on' : 'off',
      toStatus: input.enabled ? 'on' : 'off',
      note: reason,
    });
  } catch (err: any) {
    await Organization.updateOne(
      { _id: input.organizationId, 'metadata.aiKnowledgeBaseEnabled': input.enabled },
      { $set: { 'metadata.aiKnowledgeBaseEnabled': current } },
    ).catch(() => undefined);
    logger.error({ organizationId: input.organizationId, errorName: err?.name }, '[KnowledgeBase] Switch audit failed; the change was rolled back');
    throw new ApiError(503, 'The change could not be recorded, so the setting was not changed. Try again.');
  }
  return { changed: true };
}

export async function buildImportSourceLink(organizationId: string, importItemId: string): Promise<{ source: KnowledgeSource; kind: KnowledgeEntryKind }> {
  if (!mongoose.isValidObjectId(importItemId)) throw new ApiError(404, 'Import item not found');
  const item: any = await AiTrainingImportItem.findOne({ _id: importItemId, organizationId }).lean();
  if (!item) throw new ApiError(404, 'Import item not found');
  if (item.status !== 'parked_knowledge' || !(KNOWLEDGE_ENTRY_KINDS as readonly string[]).includes(item.type)) {
    throw new ApiError(409, 'Only parked FAQ and business information import items can be linked to the Knowledge Base.');
  }
  const batch: any = await AiTrainingImportBatch.findOne({ _id: item.batchId, organizationId }).select('batchNumber').lean();
  if (!batch) throw new ApiError(409, 'This import item has a data problem: its batch is missing.');
  const source: KnowledgeSource = {
    system: 'podium_import',
    importBatchId: item.batchId,
    importBatchNumber: batch.batchNumber,
    importItemId: item._id,
  };
  if (item.sourceKey) source.sourceKey = item.sourceKey;
  if (item.keyRevision) source.keyRevision = item.keyRevision;
  if (item.sourceRef) source.sourceRef = item.sourceRef;
  if (item.sourceLocationLabel) source.sourceLocationLabel = item.sourceLocationLabel;
  if (item.sourceStatus) source.sourceStatus = item.sourceStatus;
  return { source, kind: item.type };
}

export async function createKnowledgeEntry(input: {
  organizationId: string;
  user: any;
  body: unknown;
  importLink?: { source: KnowledgeSource; kind: KnowledgeEntryKind };
}): Promise<any> {
  const actor = trainingActor(input.user);
  if (input.body && typeof input.body === 'object' && 'source' in (input.body as object)) {
    throw new ApiError(400, 'Fix the highlighted fields.', [{ field: 'source', code: 'source_not_allowed', message: 'Imported entries are linked by the import process, not by this form.' }]);
  }
  const { content, changeNote } = parseKnowledgeInput(input.body);
  if (input.importLink && input.importLink.kind !== content.kind) {
    throw new ApiError(400, 'Fix the highlighted fields.', [{ field: 'kind', code: 'import_kind_mismatch', message: 'This entry must have the same type as the linked import item.' }]);
  }
  await requireStorable(input.organizationId, content);

  const entryId = new mongoose.Types.ObjectId();
  const head = headFields(content);
  try {
    await runTrainingWrite(async (session) => {
      await AiKnowledgeEntryVersion.create([{ organizationId: input.organizationId, entryId, version: 1, content, changeNote, createdBy: actor }], withSession(session));
      await AiKnowledgeEntry.create([{
        _id: entryId,
        organizationId: input.organizationId,
        kind: content.kind,
        ...head.set,
        status: 'draft',
        lifecycle: 'active',
        currentVersion: 1,
        source: input.importLink?.source || { system: 'manual' },
        createdBy: actor,
        lastEditedBy: actor,
        pendingAudit: [knowledgeAuditEntry('entry_created', actor, { version: 1, toStatus: 'draft', toLifecycle: 'active', note: changeNote })],
      }], withSession(session));
    });
  } catch (err: any) {
    if (isDuplicateKeyError(err) && input.importLink) throw new ApiError(409, 'This import item is already linked to a Knowledge Base entry.');
    mapWriteError(err);
  }
  await flushKnowledgeAudit(input.organizationId, entryId);
  return AiKnowledgeEntry.findOne({ _id: entryId, organizationId: input.organizationId }).lean();
}

export async function saveKnowledgeVersion(input: {
  organizationId: string;
  entryId: string;
  user: any;
  body: unknown;
  importLink?: { source: KnowledgeSource; kind: KnowledgeEntryKind };
}): Promise<any> {
  const actor = trainingActor(input.user);
  const reviewer = canReviewKnowledge(input.user);
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  requireActive(entry, 'edited');
  if (input.importLink && (entry.source?.system !== 'podium_import' || !entry.source?.sourceKey || entry.source.sourceKey !== input.importLink.source.sourceKey)) {
    throw new ApiError(409, 'This import item belongs to a different Knowledge Base entry.');
  }
  const isAuthor = entry.createdBy?.userId === actor.userId;
  if (entry.status === 'in_review') {
    if (!reviewer) throw new ApiError(409, 'This entry is waiting for review. A reviewer can request changes so you can edit it.');
  } else if (!EDITABLE_STATUSES.includes(entry.status)) {
    throw new ApiError(409, `This entry is ${String(entry.status).replace(/_/g, ' ')} and can't be edited`);
  } else if (!isAuthor && !reviewer) {
    throw new ApiError(403, 'Only the author or a manager can edit this entry');
  }
  const body: Record<string, unknown> = input.body && typeof input.body === 'object' && !Array.isArray(input.body) ? input.body as Record<string, unknown> : {};
  requireExpectedVersion(body.expectedVersion, entry);
  const { content, changeNote } = parseKnowledgeInput(body, entry.kind);
  await requireStorable(input.organizationId, content);

  const reviewEdit = entry.status === 'in_review';
  const nextStatus: KnowledgeEntryStatus = reviewEdit ? 'in_review' : 'draft';
  const head = headFields(content);
  let updated: any;
  try {
    updated = await runTrainingWrite(async (session) => {
      const rows: any[] = await AiKnowledgeEntryVersion.find({ organizationId: input.organizationId, entryId: entry._id }).select('version').session(session).lean();
      const nextVersion = Math.max(Number(entry.currentVersion || 0), ...rows.map((row) => Number(row.version))) + 1;
      await AiKnowledgeEntryVersion.create([{ organizationId: input.organizationId, entryId: entry._id, version: nextVersion, content, changeNote, createdBy: actor }], withSession(session));
      const unset: Record<string, ''> = { ...head.unset };
      if (!reviewEdit) unset.submittedVersion = '';
      const result = await AiKnowledgeEntry.findOneAndUpdate(
        { _id: entry._id, organizationId: input.organizationId, status: entry.status, lifecycle: 'active', currentVersion: entry.currentVersion },
        {
          $set: { ...head.set, status: nextStatus, currentVersion: nextVersion, lastEditedBy: actor, ...(reviewEdit ? { submittedVersion: nextVersion } : {}), ...(input.importLink ? { source: input.importLink.source } : {}) },
          ...(Object.keys(unset).length ? { $unset: unset } : {}),
          $push: { pendingAudit: knowledgeAuditEntry('version_saved', actor, { version: nextVersion, fromStatus: entry.status, toStatus: nextStatus, note: changeNote }) },
        },
        { new: true, ...withSession(session) },
      ).lean();
      if (!result) throw new ApiError(409, CONFLICT_MESSAGE);
      return result;
    });
  } catch (err) {
    mapWriteError(err);
  }
  await flushKnowledgeAudit(input.organizationId, entry._id);
  return updated;
}

async function loadCurrentVersion(organizationId: string, entry: any): Promise<any> {
  const current = await AiKnowledgeEntryVersion.findOne({ organizationId, entryId: entry._id, version: entry.currentVersion }).lean();
  if (!current) throw new ApiError(409, MISSING_VERSION_MESSAGE);
  return current;
}

async function transition(input: {
  organizationId: string;
  entry: any;
  filter: Record<string, unknown>;
  set: Record<string, unknown>;
  unset?: Record<string, ''>;
  audit: ReturnType<typeof knowledgeAuditEntry>;
}): Promise<any> {
  const updated = await AiKnowledgeEntry.findOneAndUpdate(
    { _id: input.entry._id, organizationId: input.organizationId, ...input.filter },
    { $set: input.set, ...(input.unset && Object.keys(input.unset).length ? { $unset: input.unset } : {}), $push: { pendingAudit: input.audit } },
    { new: true },
  ).lean();
  if (!updated) throw new ApiError(409, CONFLICT_MESSAGE);
  await flushKnowledgeAudit(input.organizationId, input.entry._id);
  return updated;
}

function canSubmitStatus(entry: any): boolean {
  return ['draft', 'changes_requested'].includes(entry.status) || (entry.status === 'approved' && needsReapproval(entry));
}

export async function submitKnowledgeEntry(input: { organizationId: string; entryId: string; user: any; expectedVersion: unknown }): Promise<any> {
  const actor = trainingActor(input.user);
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  requireActive(entry, 'submitted');
  if (!canSubmitStatus(entry)) {
    throw new ApiError(409, entry.status === 'approved'
      ? 'This entry is already approved. Edit it to start a revision.'
      : `This entry is ${String(entry.status).replace(/_/g, ' ')} and can't be submitted`);
  }
  if (entry.createdBy?.userId !== actor.userId && !canReviewKnowledge(input.user)) throw new ApiError(403, 'Only the author or a manager can submit this entry');
  requireExpectedVersion(input.expectedVersion, entry);
  const current = await loadCurrentVersion(input.organizationId, entry);
  const { blockers } = await reviewCheck(input.organizationId, current.content, null);
  if (blockers.length) throw new ApiError(400, 'This version cannot be submitted until the highlighted items are fixed.', blockers);
  return transition({
    organizationId: input.organizationId,
    entry,
    filter: { status: entry.status, lifecycle: 'active', currentVersion: entry.currentVersion },
    set: { status: 'in_review', submittedVersion: entry.currentVersion, submittedAt: new Date(), submittedBy: actor },
    audit: knowledgeAuditEntry('entry_submitted', actor, { version: entry.currentVersion, fromStatus: entry.status, toStatus: 'in_review', note: entry.status === 'approved' ? 'reapproval' : undefined }),
  });
}

export async function requestKnowledgeChanges(input: { organizationId: string; entryId: string; user: any; expectedVersion: unknown; note: unknown }): Promise<any> {
  const actor = trainingActor(input.user);
  requireKnowledgeReviewer(input.user);
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  requireActive(entry, 'reviewed');
  if (entry.status !== 'in_review') throw new ApiError(409, `This entry is ${String(entry.status).replace(/_/g, ' ')} and is not waiting for review`);
  requireExpectedVersion(input.expectedVersion, entry);
  const note = cleanKnowledgeNote(input.note, true);
  return transition({
    organizationId: input.organizationId,
    entry,
    filter: { status: 'in_review', lifecycle: 'active', currentVersion: entry.currentVersion },
    set: { status: 'changes_requested', lastReview: { action: 'request_changes', note, by: actor, at: new Date() } },
    audit: knowledgeAuditEntry('changes_requested', actor, { version: entry.currentVersion, fromStatus: 'in_review', toStatus: 'changes_requested', note }),
  });
}

export async function rejectKnowledgeEntry(input: { organizationId: string; entryId: string; user: any; expectedVersion: unknown; note: unknown }): Promise<any> {
  const actor = trainingActor(input.user);
  requireKnowledgeReviewer(input.user);
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  requireActive(entry, 'reviewed');
  if (!['in_review', 'changes_requested'].includes(entry.status)) throw new ApiError(409, `This entry is ${String(entry.status).replace(/_/g, ' ')} and can't be rejected`);
  requireExpectedVersion(input.expectedVersion, entry);
  const note = cleanKnowledgeNote(input.note, true);
  return transition({
    organizationId: input.organizationId,
    entry,
    filter: { status: entry.status, lifecycle: 'active', currentVersion: entry.currentVersion },
    set: { status: 'rejected', lastReview: { action: 'reject', note, by: actor, at: new Date() } },
    audit: knowledgeAuditEntry('entry_rejected', actor, { version: entry.currentVersion, fromStatus: entry.status, toStatus: 'rejected', note }),
  });
}

export async function approveKnowledgeEntry(input: { organizationId: string; entryId: string; user: any; expectedVersion: unknown; note?: unknown }): Promise<any> {
  const actor = trainingActor(input.user);
  requireKnowledgeReviewer(input.user);
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  requireActive(entry, 'approved');
  if (entry.status !== 'in_review') throw new ApiError(409, `This entry is ${String(entry.status).replace(/_/g, ' ')} and is not waiting for review`);
  requireExpectedVersion(input.expectedVersion, entry);
  if (entry.submittedVersion !== entry.currentVersion) throw new ApiError(409, STALE_MESSAGE);
  if (entry.createdBy?.userId === actor.userId) {
    throw new ApiError(403, 'You cannot approve your own entry. Ask another manager or admin to review it.');
  }
  const current = await loadCurrentVersion(input.organizationId, entry);
  const editedSinceApproval: any[] = await AiKnowledgeEntryVersion.find({
    organizationId: input.organizationId,
    entryId: entry._id,
    version: { $gt: Number(entry.approvedVersion || 0), $lte: entry.currentVersion },
  }).select('createdBy').lean();
  if (current.createdBy?.userId === actor.userId || editedSinceApproval.some((row) => row.createdBy?.userId === actor.userId)) {
    throw new ApiError(403, 'You edited this entry since it was last approved, so another manager or admin needs to approve it.');
  }
  const note = cleanKnowledgeNote(input.note, false);
  const key = knowledgeKey(current.content);
  const now = new Date();
  let updated: any;
  try {
    updated = await runTrainingWrite(async (session) => {
      await lockKnowledgeLocations(input.organizationId, session);
      const { blockers, details } = await reviewCheck(input.organizationId, current.content, session);
      if (blockers.length) {
        throw new ApiError(400, 'This version cannot be approved until the highlighted items are fixed. Request changes so the author can update it.', blockers);
      }
      const dependencies = matchKnowledgeDependencies(current.content, details);
      await lockKnowledgeDependencies(input.organizationId, dependencies, session);
      await lockKnowledgeKey(input.organizationId, entry.kind, key, session);
      const clash = await approvedConflicts(input.organizationId, entry._id, entry.kind, key, current.content.locationScope, session);
      if (clash.length) throw new ApiError(409, OVERLAP_MESSAGE, [overlapIssue(entry.kind, clash)]);
      const result = await AiKnowledgeEntry.findOneAndUpdate(
        { _id: entry._id, organizationId: input.organizationId, status: 'in_review', lifecycle: 'active', currentVersion: entry.currentVersion, submittedVersion: entry.currentVersion },
        {
          $set: {
            status: 'approved',
            approvedVersion: entry.currentVersion,
            approvedKey: key,
            approvedLocationScope: current.content.locationScope,
            approvedDependencies: dependencies,
            approvalSuspendedLocationIds: [],
            approvedBy: actor,
            approvedAt: now,
            lastReview: { action: 'approve', note, by: actor, at: now },
          },
          $unset: { approvalInvalidation: '' },
          $push: { pendingAudit: knowledgeAuditEntry('entry_approved', actor, { version: entry.currentVersion, fromStatus: 'in_review', toStatus: 'approved', note }) },
        },
        { new: true, ...withSession(session) },
      ).lean();
      if (!result) throw new ApiError(409, CONFLICT_MESSAGE);
      return result;
    });
  } catch (err) {
    mapWriteError(err);
  }
  await flushKnowledgeAudit(input.organizationId, entry._id);
  return updated;
}

export async function disableKnowledgeEntry(input: { organizationId: string; entryId: string; user: any; note?: unknown }): Promise<any> {
  const actor = trainingActor(input.user);
  requireKnowledgeReviewer(input.user);
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  if (entry.lifecycle !== 'active') throw new ApiError(409, `This entry is already ${entry.lifecycle}`);
  const note = cleanKnowledgeNote(input.note, false);
  return transition({
    organizationId: input.organizationId,
    entry,
    filter: { lifecycle: 'active' },
    set: { lifecycle: 'disabled', disabledAt: new Date(), disabledBy: actor },
    audit: knowledgeAuditEntry('entry_disabled', actor, { version: entry.currentVersion, fromLifecycle: 'active', toLifecycle: 'disabled', note }),
  });
}

export async function enableKnowledgeEntry(input: { organizationId: string; entryId: string; user: any; note?: unknown }): Promise<any> {
  const actor = trainingActor(input.user);
  requireKnowledgeReviewer(input.user);
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  if (entry.lifecycle !== 'disabled') throw new ApiError(409, entry.lifecycle === 'archived' ? "Archived entries can't be turned back on. Restore the entry instead." : 'This entry is already on');
  const note = cleanKnowledgeNote(input.note, false);
  const filter = {
    _id: entry._id,
    organizationId: input.organizationId,
    lifecycle: 'disabled',
    status: entry.status,
    currentVersion: entry.currentVersion,
    approvedVersion: entry.approvedVersion ?? { $exists: false },
  };
  const update = {
    $set: { lifecycle: 'active' },
    $unset: { disabledAt: '', disabledBy: '' },
    $push: { pendingAudit: knowledgeAuditEntry('entry_enabled', actor, { version: entry.currentVersion, fromLifecycle: 'disabled', toLifecycle: 'active', note }) },
  };
  let updated: any;
  try {
    const effective = effectiveApprovedScope(entry);
    if (!entry.approvedVersion || entry.approvalInvalidation || !effective) {
      updated = await AiKnowledgeEntry.findOneAndUpdate(filter, update, { new: true }).lean();
      if (!updated) throw new ApiError(409, CONFLICT_MESSAGE);
    } else {
      const approved: any = await AiKnowledgeEntryVersion.findOne({ organizationId: input.organizationId, entryId: entry._id, version: entry.approvedVersion }).lean();
      if (!approved) throw new ApiError(409, 'This entry has a data problem: its approved version is missing. Nothing was changed.');
      const key = knowledgeKey(approved.content);
      updated = await runTrainingWrite(async (session) => {
        await lockKnowledgeLocations(input.organizationId, session);
        const { blockers } = await reviewCheck(input.organizationId, { ...approved.content, locationScope: effective }, session);
        if (blockers.length) {
          throw new ApiError(400, "This entry can't be turned back on. Its approved version no longer passes the current checks. It stays disabled until a new version is approved.", blockers);
        }
        await lockKnowledgeDependencies(input.organizationId, entry.approvedDependencies || [], session);
        await lockKnowledgeKey(input.organizationId, entry.kind, key, session);
        const clash = await approvedConflicts(input.organizationId, entry._id, entry.kind, key, effective, session);
        if (clash.length) throw new ApiError(409, OVERLAP_MESSAGE, [overlapIssue(entry.kind, clash)]);
        const result = await AiKnowledgeEntry.findOneAndUpdate({ ...filter, approvalInvalidation: { $exists: false } }, update, { new: true, ...withSession(session) }).lean();
        if (!result) throw new ApiError(409, CONFLICT_MESSAGE);
        return result;
      });
    }
  } catch (err) {
    mapWriteError(err);
  }
  await flushKnowledgeAudit(input.organizationId, entry._id);
  return updated;
}

export async function archiveKnowledgeEntry(input: { organizationId: string; entryId: string; user: any; note?: unknown }): Promise<any> {
  const actor = trainingActor(input.user);
  requireKnowledgeReviewer(input.user, 'Only managers or admins can archive Knowledge Base entries');
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  if (entry.lifecycle === 'archived') throw new ApiError(409, 'This entry is already archived');
  const note = cleanKnowledgeNote(input.note, false);
  return transition({
    organizationId: input.organizationId,
    entry,
    filter: { lifecycle: entry.lifecycle },
    set: { lifecycle: 'archived', archivedAt: new Date(), archivedBy: actor },
    audit: knowledgeAuditEntry('entry_archived', actor, { version: entry.currentVersion, fromLifecycle: entry.lifecycle, toLifecycle: 'archived', note }),
  });
}

export async function restoreKnowledgeEntry(input: { organizationId: string; entryId: string; user: any; note?: unknown }): Promise<any> {
  const actor = trainingActor(input.user);
  requireKnowledgeReviewer(input.user, 'Only managers or admins can restore Knowledge Base entries');
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  if (entry.lifecycle !== 'archived') throw new ApiError(409, 'Only archived entries can be restored');
  const note = cleanKnowledgeNote(input.note, false);
  const now = new Date();
  const set: Record<string, unknown> = { lifecycle: 'active', restoredAt: now, restoredBy: actor };
  const unset: Record<string, ''> = { archivedAt: '', archivedBy: '' };
  if (entry.status === 'in_review') {
    set.status = 'draft';
    unset.submittedVersion = '';
  }
  if (entry.approvedVersion) set.approvalInvalidation = { reason: 'entry_restored', at: now, by: actor };
  return transition({
    organizationId: input.organizationId,
    entry,
    filter: { lifecycle: 'archived', status: entry.status, currentVersion: entry.currentVersion },
    set,
    unset,
    audit: knowledgeAuditEntry('entry_restored', actor, {
      version: entry.currentVersion, fromLifecycle: 'archived', toLifecycle: 'active', fromStatus: entry.status, toStatus: String(set.status || entry.status), note,
    }),
  });
}

export function serializeKnowledgeEntry(entry: any, viewer: any, active?: Set<string>) {
  const viewerId = String(viewer?._id || '');
  const actor = (ref: any) => (ref ? { name: ref.name, role: ref.role } : undefined);
  const effective = effectiveApprovedScope(entry);
  const state = knowledgeApprovalState(entry, active);
  return {
    id: String(entry._id),
    kind: entry.kind,
    topic: entry.topic,
    title: entry.title,
    question: entry.question || undefined,
    channels: entry.channels || [],
    locationScope: { scope: entry.locationScope?.scope, locationIds: (entry.locationScope?.locationIds || []).map(String) },
    status: entry.status,
    lifecycle: entry.lifecycle,
    currentVersion: entry.currentVersion,
    submittedVersion: entry.submittedVersion || undefined,
    approvedVersion: entry.approvedVersion || undefined,
    approval: entry.approvedVersion
      ? {
        version: entry.approvedVersion,
        state,
        valid: !entry.approvalInvalidation && Boolean(effective),
        needsReapproval: needsReapproval(entry, active),
        invalidation: entry.approvalInvalidation ? { reason: entry.approvalInvalidation.reason, at: entry.approvalInvalidation.at, by: actor(entry.approvalInvalidation.by) } : undefined,
        scope: entry.approvedLocationScope ? { scope: entry.approvedLocationScope.scope, locationIds: (entry.approvedLocationScope.locationIds || []).map(String) } : undefined,
        suspendedLocationIds: (entry.approvalSuspendedLocationIds || []).map(String),
        activeSuspendedLocationIds: (active ? activeSuspensions(entry.approvalSuspendedLocationIds, active) : entry.approvalSuspendedLocationIds || []).map(String),
        dependencyCount: (entry.approvedDependencies || []).length,
      }
      : undefined,
    source: {
      system: entry.source?.system || 'manual',
      importBatchId: entry.source?.importBatchId ? String(entry.source.importBatchId) : undefined,
      importBatchNumber: entry.source?.importBatchNumber || undefined,
      importItemId: entry.source?.importItemId ? String(entry.source.importItemId) : undefined,
      sourceRef: entry.source?.sourceRef || undefined,
      sourceLocationLabel: entry.source?.sourceLocationLabel || undefined,
      sourceStatus: entry.source?.sourceStatus || undefined,
    },
    createdBy: actor(entry.createdBy),
    isMine: entry.createdBy?.userId === viewerId,
    lastEditedBy: actor(entry.lastEditedBy),
    submittedAt: entry.submittedAt || undefined,
    lastReview: entry.lastReview?.action
      ? { action: entry.lastReview.action, note: entry.lastReview.note || undefined, by: actor(entry.lastReview.by), at: entry.lastReview.at }
      : undefined,
    approvedBy: actor(entry.approvedBy),
    approvedAt: entry.approvedAt || undefined,
    disabledAt: entry.disabledAt || undefined,
    archivedAt: entry.archivedAt || undefined,
    restoredAt: entry.restoredAt || undefined,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function serializeVersion(row: any) {
  return {
    version: row.version,
    content: {
      ...row.content,
      locationScope: { scope: row.content?.locationScope?.scope, locationIds: (row.content?.locationScope?.locationIds || []).map(String) },
    },
    changeNote: row.changeNote || undefined,
    createdBy: row.createdBy ? { name: row.createdBy.name, role: row.createdBy.role } : undefined,
    createdAt: row.createdAt,
  };
}

export async function getKnowledgeEntryDetail(input: { organizationId: string; entryId: string; user: any }) {
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  const versions: any[] = await AiKnowledgeEntryVersion.find({
    organizationId: input.organizationId,
    entryId: entry._id,
    version: { $in: [entry.currentVersion, entry.approvedVersion].filter(Boolean) },
  }).lean();
  const current = versions.find((row) => row.version === entry.currentVersion);
  const approved = entry.approvedVersion && entry.approvedVersion !== entry.currentVersion
    ? versions.find((row) => row.version === entry.approvedVersion)
    : undefined;
  let check: KnowledgeCheck = { errors: [], warnings: [] };
  let duplicates: Array<{ id: string; status: string; lifecycle: string }> = [];
  let conflicts: string[] = [];
  if (current) {
    check = (await reviewCheck(input.organizationId, current.content, null)).check;
    const key = knowledgeKey(current.content);
    duplicates = await possibleDuplicates(input.organizationId, entry._id, entry.kind, key, current.content.locationScope);
    conflicts = await approvedConflicts(input.organizationId, entry._id, entry.kind, key, current.content.locationScope, null);
  }
  const actor = trainingActor(input.user);
  const reviewer = canReviewKnowledge(input.user);
  const isAuthor = entry.createdBy?.userId === actor.userId;
  const active = await activeLocationIds(input.organizationId);
  return {
    entry: serializeKnowledgeEntry(entry, input.user, active),
    current: current ? serializeVersion(current) : null,
    approved: approved ? serializeVersion(approved) : undefined,
    check,
    duplicates,
    conflicts,
    permissions: {
      canEdit: entry.lifecycle === 'active' && (entry.status === 'in_review' ? reviewer : EDITABLE_STATUSES.includes(entry.status) && (isAuthor || reviewer)),
      canSubmit: entry.lifecycle === 'active' && canSubmitStatus(entry) && (isAuthor || reviewer),
      canReview: reviewer && entry.lifecycle === 'active' && entry.status === 'in_review',
      canDisable: reviewer && entry.lifecycle === 'active',
      canEnable: reviewer && entry.lifecycle === 'disabled',
      canArchive: reviewer && entry.lifecycle !== 'archived',
      canRestore: reviewer && entry.lifecycle === 'archived',
    },
  };
}

export async function listKnowledgeVersions(input: { organizationId: string; entryId: string; user: any }) {
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  const rows: any[] = await AiKnowledgeEntryVersion.find({ organizationId: input.organizationId, entryId: entry._id })
    .select('version changeNote createdBy createdAt').sort({ version: -1 }).limit(200).lean();
  return rows.map((row) => ({
    version: row.version,
    changeNote: row.changeNote || undefined,
    createdBy: row.createdBy ? { name: row.createdBy.name, role: row.createdBy.role } : undefined,
    createdAt: row.createdAt,
    isCurrent: row.version === entry.currentVersion,
    isApproved: row.version === entry.approvedVersion,
  }));
}

export async function getKnowledgeVersion(input: { organizationId: string; entryId: string; user: any; version: unknown }) {
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) throw new ApiError(404, 'Version not found');
  const row = await AiKnowledgeEntryVersion.findOne({ organizationId: input.organizationId, entryId: entry._id, version }).lean();
  if (!row) throw new ApiError(404, 'Version not found');
  return serializeVersion(row);
}

function serializeAudit(row: any) {
  return {
    id: String(row._id),
    entryId: row.entryId ? String(row.entryId) : undefined,
    detailId: row.detailId ? String(row.detailId) : undefined,
    locationId: row.locationId ? String(row.locationId) : undefined,
    action: row.action,
    version: row.version || undefined,
    fromStatus: row.fromStatus || undefined,
    toStatus: row.toStatus || undefined,
    fromLifecycle: row.fromLifecycle || undefined,
    toLifecycle: row.toLifecycle || undefined,
    note: row.note || undefined,
    actor: row.actor ? { name: row.actor.name, role: row.actor.role } : undefined,
    createdAt: row.createdAt,
  };
}

export async function listKnowledgeEntryAudit(input: { organizationId: string; entryId: string; user: any }) {
  const entry = await loadVisibleEntry(input.organizationId, input.entryId, input.user);
  await flushKnowledgeAudit(input.organizationId, entry._id);
  const rows: any[] = await AiKnowledgeAuditLog.find({ organizationId: input.organizationId, entryId: entry._id })
    .sort({ createdAt: -1, _id: -1 }).limit(KNOWLEDGE_LIMITS.auditRows).lean();
  return rows.map(serializeAudit);
}

export async function listKnowledgeAudit(input: { organizationId: string; user: any; page: number; limit: number }) {
  requireKnowledgeReviewer(input.user);
  const filter = { organizationId: input.organizationId };
  const [rows, total] = await Promise.all([
    AiKnowledgeAuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip((input.page - 1) * input.limit).limit(input.limit).lean(),
    AiKnowledgeAuditLog.countDocuments(filter),
  ]);
  return { items: rows.map(serializeAudit), page: input.page, limit: input.limit, total };
}

function enumFilter(raw: unknown, allowed: readonly string[], name: string): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !allowed.includes(raw)) throw new ApiError(400, `${name} must be one of: ${allowed.join(', ')}`);
  return raw;
}

export async function listKnowledgeEntries(input: { organizationId: string; user: any; query: Record<string, unknown>; page: number; limit: number }) {
  const filter: Record<string, unknown> = knowledgeVisibilityFilter(input.organizationId, input.user);
  const and: Record<string, unknown>[] = [];
  const status = enumFilter(input.query.status, KNOWLEDGE_ENTRY_STATUSES, 'status');
  const lifecycle = enumFilter(input.query.lifecycle, KNOWLEDGE_ENTRY_LIFECYCLES, 'lifecycle');
  const kind = enumFilter(input.query.kind, KNOWLEDGE_ENTRY_KINDS, 'kind');
  const topic = enumFilter(input.query.topic, KNOWLEDGE_BASE_TOPICS, 'topic');
  const source = enumFilter(input.query.source, KNOWLEDGE_SOURCE_SYSTEMS, 'source');
  if (status) filter.status = status;
  filter.lifecycle = lifecycle || { $ne: 'archived' };
  if (kind) filter.kind = kind;
  if (topic) filter.topic = topic;
  if (source) filter['source.system'] = source;
  if (input.query.needsReapproval === 'true') {
    and.push({ approvedVersion: { $gte: 1 } }, { $or: [{ approvalInvalidation: { $exists: true } }, { 'approvalSuspendedLocationIds.0': { $exists: true } }] });
  }
  const locationId = input.query.locationId;
  if (locationId !== undefined && locationId !== '') {
    if (typeof locationId !== 'string' || !mongoose.isValidObjectId(locationId)) throw new ApiError(400, 'locationId must be a location id');
    and.push({ $or: [{ 'locationScope.scope': 'all' }, { 'locationScope.locationIds': new mongoose.Types.ObjectId(locationId) }] });
  }
  const search = input.query.q;
  if (search !== undefined && search !== '') {
    if (typeof search !== 'string') throw new ApiError(400, 'Search must be text');
    const term = search.trim();
    if (term.length > KNOWLEDGE_LIMITS.search) throw new ApiError(400, `Search can be at most ${KNOWLEDGE_LIMITS.search} characters`);
    if (term) {
      const pattern = { $regex: escapeRegex(term), $options: 'i' };
      and.push({ $or: [{ title: pattern }, { question: pattern }] });
    }
  }
  if (and.length) filter.$and = and;
  const [rows, total, active] = await Promise.all([
    AiKnowledgeEntry.find(filter).sort({ updatedAt: -1, _id: -1 }).skip((input.page - 1) * input.limit).limit(input.limit).lean(),
    AiKnowledgeEntry.countDocuments(filter),
    activeLocationIds(input.organizationId),
  ]);
  return { items: rows.map((row) => serializeKnowledgeEntry(row, input.user, active)), page: input.page, limit: input.limit, total };
}

export async function listKnowledgeLocations(organizationId: string) {
  const rows: any[] = await CrmLocation.find({ organizationId }).select('name code status').sort({ status: 1, name: 1 }).limit(200).lean();
  return rows.map((row) => ({ id: String(row._id), name: row.name, code: row.code, status: row.status }));
}

export async function knowledgeBaseStatus(organizationId: string, user: any) {
  const availability = await resolveKnowledgeBaseAvailability(organizationId);
  return {
    ...availability,
    canCreate: true,
    canReview: canReviewKnowledge(user),
    canManageSettings: trainingRole(user) === 'admin',
    affectsAlex: false,
  };
}

export type { TrainingActorRef };
