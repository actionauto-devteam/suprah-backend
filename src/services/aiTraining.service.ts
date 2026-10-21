import mongoose, { ClientSession } from 'mongoose';
import Organization from '../models/Organization.model';
import AiAgentDraft from '../models/AiAgentDraft.model';
import AiTrainingPolicy, {
  IAiTrainingPolicy,
  TrainingActorRef,
  TrainingPendingAudit,
  TrainingPolicyStatus,
} from '../models/AiTrainingPolicy.model';
import AiTrainingPolicyVersion from '../models/AiTrainingPolicyVersion.model';
import AiTrainingAuditLog, { TrainingAuditAction } from '../models/AiTrainingAuditLog.model';
import AiDraftEvaluation, {
  DRAFT_EVALUATION_RATINGS,
  DRAFT_EVALUATION_RETENTION_DAYS,
  DRAFT_EVALUATION_TAGS,
} from '../models/AiDraftEvaluation.model';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';

export type TrainingRole = 'rep' | 'manager' | 'admin';

export const MAX_INSTRUCTION_LENGTH = 800;
export const MAX_REVIEW_NOTE_LENGTH = 500;
export const MAX_CORRECTED_REPLY_LENGTH = 1000;
const OPEN_PROPOSAL_STATUSES: TrainingPolicyStatus[] = ['draft', 'in_review', 'changes_requested'];

export function trainingRole(user: any): TrainingRole {
  const role = String(user?.role || '');
  if (role === 'admin' || role === 'super_admin') return 'admin';
  if (role === 'manager') return 'manager';
  return 'rep';
}

export function canReviewTraining(role: TrainingRole): boolean {
  return role === 'manager' || role === 'admin';
}

export function trainingActor(user: any): TrainingActorRef {
  const name = user?.fullName || user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || 'Team member';
  return { userId: String(user?._id || ''), name: String(name).slice(0, 120), role: trainingRole(user) };
}

export function isTrainingGloballyEnabled(): boolean {
  return process.env.AI_TRAINING_ENABLED === 'true';
}

export async function resolveTrainingAvailability(organizationId: string) {
  const org: any = await Organization.findById(organizationId).select('metadata').lean();
  const globalEnabled = isTrainingGloballyEnabled();
  const orgEnabled = org?.metadata?.aiTrainingEnabled === true;
  return { found: Boolean(org), globalEnabled, orgEnabled, enabled: Boolean(org) && globalEnabled && orgEnabled };
}

export async function requireTrainingEnabled(organizationId: string): Promise<void> {
  const availability = await resolveTrainingAvailability(organizationId);
  if (!availability.enabled) throw new ApiError(409, 'AI training is turned off for this organization');
}

export async function writeTrainingAudit(entry: {
  organizationId: string;
  action: TrainingAuditAction;
  actor: TrainingActorRef;
  policyId?: any;
  version?: number;
  draftId?: any;
  evaluationId?: any;
  legacyCoachingRuleId?: any;
  fromStatus?: string;
  toStatus?: string;
  note?: string;
}): Promise<void> {
  try {
    await AiTrainingAuditLog.create({ ...entry, note: entry.note ? String(entry.note).slice(0, MAX_REVIEW_NOTE_LENGTH) : undefined });
  } catch (err: any) {
    logger.error({ organizationId: entry.organizationId, action: entry.action, errorName: err?.name }, '[AiTraining] Audit record could not be written');
  }
}

function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000 || /E11000/.test(String(err?.message || ''));
}

export function auditEntry(
  action: TrainingAuditAction,
  actor: TrainingActorRef,
  extra: { version?: number; fromStatus?: string; toStatus?: string; note?: string } = {},
): TrainingPendingAudit {
  const entry: TrainingPendingAudit = { _id: new mongoose.Types.ObjectId(), action, actor, createdAt: new Date() };
  if (extra.version !== undefined) entry.version = extra.version;
  if (extra.fromStatus) entry.fromStatus = extra.fromStatus;
  if (extra.toStatus) entry.toStatus = extra.toStatus;
  if (extra.note) entry.note = String(extra.note).slice(0, MAX_REVIEW_NOTE_LENGTH);
  return entry;
}

function auditRow(organizationId: string, policyId: any, entry: any) {
  const row: Record<string, unknown> = {
    _id: entry._id,
    organizationId,
    policyId,
    action: entry.action,
    actor: entry.actor,
    createdAt: entry.createdAt,
  };
  for (const key of ['version', 'fromStatus', 'toStatus', 'note']) {
    if (entry[key] !== undefined && entry[key] !== null) row[key] = entry[key];
  }
  return row;
}

export async function flushPolicyAudit(organizationId: string, policyId: any): Promise<boolean> {
  try {
    const policy: any = await AiTrainingPolicy.findOne({ _id: policyId, organizationId }).select('pendingAudit').lean();
    const pending: any[] = policy?.pendingAudit || [];
    if (!pending.length) return true;
    for (const entry of pending) {
      try {
        await AiTrainingAuditLog.collection.insertOne(auditRow(organizationId, policy._id, entry) as any);
      } catch (err) {
        if (!isDuplicateKeyError(err)) throw err;
      }
    }
    await AiTrainingPolicy.updateOne(
      { _id: policy._id, organizationId },
      { $pull: { pendingAudit: { _id: { $in: pending.map((entry) => entry._id) } } } },
    );
    return true;
  } catch (err: any) {
    logger.warn({ organizationId, policyId: String(policyId), errorName: err?.name }, '[AiTraining] Audit outbox flush deferred; entries stay on the proposal until the next write');
    return false;
  }
}

export async function pendingAuditRows(organizationId: string, policyId?: any): Promise<any[]> {
  const filter: Record<string, unknown> = { organizationId, 'pendingAudit.0': { $exists: true } };
  if (policyId) filter._id = policyId;
  const policies: any[] = await AiTrainingPolicy.find(filter).select('pendingAudit').limit(200).lean();
  const rows = policies.flatMap((policy) => (policy.pendingAudit || []).map((entry: any) => auditRow(organizationId, policy._id, entry)));
  if (!rows.length) return [];
  const logged = await AiTrainingAuditLog.find({ organizationId, _id: { $in: rows.map((row) => row._id) } }).select('_id').lean();
  const loggedIds = new Set(logged.map((row: any) => String(row._id)));
  return rows.filter((row) => !loggedIds.has(String(row._id)));
}

function cleanInstruction(value: unknown): string {
  const instruction = String(value || '').trim();
  if (!instruction) throw new ApiError(400, 'An instruction is required');
  if (instruction.length > MAX_INSTRUCTION_LENGTH) throw new ApiError(400, `Instructions can be at most ${MAX_INSTRUCTION_LENGTH} characters`);
  return instruction;
}

function cleanNote(value: unknown, required: boolean): string | undefined {
  const note = String(value || '').trim();
  if (required && !note) throw new ApiError(400, 'Please add a short note for the author');
  if (note.length > MAX_REVIEW_NOTE_LENGTH) throw new ApiError(400, `Notes can be at most ${MAX_REVIEW_NOTE_LENGTH} characters`);
  return note || undefined;
}

function titleFrom(instruction: string): string {
  const firstLine = instruction.split(/\r?\n/)[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

export function proposalVisibilityFilter(organizationId: string, user: any): Record<string, unknown> {
  const filter: Record<string, unknown> = { organizationId };
  if (!canReviewTraining(trainingRole(user))) filter['createdBy.userId'] = String(user?._id || '');
  return filter;
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function titleSearchFilter(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === '') return {};
  if (typeof raw !== 'string') throw new ApiError(400, 'Search must be text');
  const term = raw.trim();
  if (term.length > 100) throw new ApiError(400, 'Search can be at most 100 characters');
  return term ? { title: { $regex: escapeRegex(term), $options: 'i' } } : {};
}

export async function loadVisibleProposal(organizationId: string, policyId: string, user: any): Promise<IAiTrainingPolicy> {
  if (!mongoose.isValidObjectId(policyId)) throw new ApiError(404, 'Proposal not found');
  const policy = await AiTrainingPolicy.findOne({ _id: policyId, ...proposalVisibilityFilter(organizationId, user) });
  if (!policy) throw new ApiError(404, 'Proposal not found');
  return policy;
}

let transactionsUnavailable = false;

export function resetTrainingTransactionProbe(): void {
  transactionsUnavailable = false;
}

function transactionsUnsupported(err: any): boolean {
  return err?.code === 20 || /Transaction numbers are only allowed|replica set member or mongos|does not support transactions|Transactions are not supported/i
    .test(String(err?.message || ''));
}

export function nonTransactionalTrainingWritesAllowed(): boolean {
  if ((process.env.AI_TRAINING_REQUIRE_TRANSACTIONS || '').trim().toLowerCase() === 'true') return false;
  return (process.env.NODE_ENV || '').trim().toLowerCase() !== 'production';
}

const TRANSACTIONS_REQUIRED_MESSAGE = 'Training changes need database transactions, which this database does not support. Nothing was changed.';

export async function runTrainingWrite<T>(work: (session: ClientSession | null) => Promise<T>): Promise<T> {
  if (transactionsUnavailable) {
    if (!nonTransactionalTrainingWritesAllowed()) throw new ApiError(503, TRANSACTIONS_REQUIRED_MESSAGE);
    return work(null);
  }
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result as T;
  } catch (err) {
    if (!transactionsUnsupported(err)) throw err;
    transactionsUnavailable = true;
    if (!nonTransactionalTrainingWritesAllowed()) {
      logger.error('[AiTraining] Database does not support transactions; training writes are refused in production');
      throw new ApiError(503, TRANSACTIONS_REQUIRED_MESSAGE);
    }
    logger.warn('[AiTraining] Database does not support transactions; using version-first writes with integrity checks (local development only)');
    return work(null);
  } finally {
    await session.endSession();
  }
}

const withSession = (session: ClientSession | null) => (session ? { session } : {});

const CONFLICT_MESSAGE = 'This proposal was just changed by someone else. Refresh and try again.';

export function adoptedVersionList(policy: any, existing: number[]): number[] {
  if (Array.isArray(policy?.adoptedVersions) && policy.adoptedVersions.length) return [...policy.adoptedVersions];
  return existing.filter((version) => version <= Number(policy?.currentVersion || 0)).sort((a, b) => a - b);
}

type VersionContent = {
  spec: Record<string, unknown>;
  changeNote?: string;
  createdBy: TrainingActorRef;
  originalAiMessageSnapshot?: string;
};

export async function createPolicyWithFirstVersion(input: {
  organizationId: string;
  policy: Record<string, unknown>;
  version: VersionContent;
  session: ClientSession | null;
}): Promise<IAiTrainingPolicy> {
  const policyId = new mongoose.Types.ObjectId();
  await AiTrainingPolicyVersion.create([{ organizationId: input.organizationId, policyId, version: 1, ...input.version }], withSession(input.session));
  const [policy] = await AiTrainingPolicy.create(
    [{ ...input.policy, _id: policyId, organizationId: input.organizationId, currentVersion: 1, adoptedVersions: [1] }],
    withSession(input.session),
  );
  return policy;
}

export async function appendPolicyVersion(input: {
  organizationId: string;
  policy: any;
  version: VersionContent;
  set: (version: number) => Record<string, unknown>;
  audit: (version: number) => TrainingPendingAudit[];
  session: ClientSession | null;
}): Promise<{ updated: IAiTrainingPolicy; version: number }> {
  const options = withSession(input.session);
  const rows = await AiTrainingPolicyVersion.find({ organizationId: input.organizationId, policyId: input.policy._id })
    .select('version').session(input.session).lean();
  const existing = rows.map((row: any) => Number(row.version));
  const nextVersion = Math.max(Number(input.policy.currentVersion || 0), ...existing) + 1;
  try {
    await AiTrainingPolicyVersion.create(
      [{ organizationId: input.organizationId, policyId: input.policy._id, version: nextVersion, ...input.version }],
      options,
    );
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ApiError(409, CONFLICT_MESSAGE);
    throw err;
  }
  const updated = await AiTrainingPolicy.findOneAndUpdate(
    { _id: input.policy._id, organizationId: input.organizationId, status: input.policy.status, currentVersion: input.policy.currentVersion },
    {
      $set: { ...input.set(nextVersion), currentVersion: nextVersion, adoptedVersions: [...adoptedVersionList(input.policy, existing), nextVersion] },
      $push: { pendingAudit: { $each: input.audit(nextVersion) } },
    },
    { new: true, ...options },
  );
  if (!updated) throw new ApiError(409, CONFLICT_MESSAGE);
  return { updated, version: nextVersion };
}

export interface PolicyIntegrityIssue {
  code: 'missing_current_version' | 'missing_submitted_version' | 'missing_adopted_version' | 'missing_approval_audit' | 'unadopted_versions' | 'stale_pending_audit';
  severity: 'critical' | 'warning';
  message: string;
}

export interface PolicyIntegrity {
  ok: boolean;
  issues: PolicyIntegrityIssue[];
  versions: number[];
  adoptedVersions: number[];
}

const STALE_PENDING_AUDIT_MS = 10 * 60 * 1000;

export async function checkPolicyIntegrity(organizationId: string, policy: any): Promise<PolicyIntegrity> {
  const rows = await AiTrainingPolicyVersion.find({ organizationId, policyId: policy._id }).select('version').lean();
  const versions = rows.map((row: any) => Number(row.version)).sort((a, b) => a - b);
  const adopted = adoptedVersionList(policy, versions);
  const issues: PolicyIntegrityIssue[] = [];
  if (!versions.includes(Number(policy.currentVersion))) {
    issues.push({ code: 'missing_current_version', severity: 'critical', message: `Version ${policy.currentVersion} is missing.` });
  }
  if (policy.submittedVersion && !versions.includes(Number(policy.submittedVersion))) {
    issues.push({ code: 'missing_submitted_version', severity: 'critical', message: `Submitted version ${policy.submittedVersion} is missing.` });
  }
  const missingAdopted = adopted.filter((version) => !versions.includes(version));
  if (Array.isArray(policy.adoptedVersions) && missingAdopted.length) {
    issues.push({ code: 'missing_adopted_version', severity: 'critical', message: `Recorded versions ${missingAdopted.join(', ')} are missing.` });
  }
  if (policy.status === 'approved') {
    const pendingApproval = (policy.pendingAudit || []).some((entry: any) => entry.action === 'proposal_approved');
    const loggedApproval = pendingApproval || await AiTrainingAuditLog.exists({ organizationId, policyId: policy._id, action: 'proposal_approved' });
    if (!loggedApproval) issues.push({ code: 'missing_approval_audit', severity: 'critical', message: 'The approval has no audit record.' });
  }
  const unadopted = versions.filter((version) => !adopted.includes(version));
  if (unadopted.length) {
    issues.push({ code: 'unadopted_versions', severity: 'warning', message: `Versions ${unadopted.join(', ')} were written but never became part of the proposal.` });
  }
  const oldestPending = (policy.pendingAudit || []).reduce((oldest: number, entry: any) => Math.min(oldest, new Date(entry.createdAt).getTime()), Infinity);
  if (Number.isFinite(oldestPending) && Date.now() - oldestPending > STALE_PENDING_AUDIT_MS) {
    issues.push({ code: 'stale_pending_audit', severity: 'warning', message: 'Some audit entries have not been copied to the audit log yet.' });
  }
  return { ok: !issues.some((issue) => issue.severity === 'critical'), issues, versions, adoptedVersions: adopted.filter((version) => versions.includes(version)) };
}

export async function requirePolicyIntegrity(organizationId: string, policy: any): Promise<void> {
  const integrity = await checkPolicyIntegrity(organizationId, policy);
  if (!integrity.ok) {
    throw new ApiError(409, 'This proposal has a data problem and cannot be approved or submitted until an admin repairs it.',
      integrity.issues.filter((issue) => issue.severity === 'critical'));
  }
}

export async function submitCoachingAsProposal(input: {
  organizationId: string;
  user: any;
  instruction: string;
  channel: 'sms' | 'webchat';
  leadId: string;
  messageId: string;
  messageModel: 'CommunicationMessage' | 'WebChatMessage';
  aiLogId?: any;
  originalAiMessageSnapshot?: string;
}): Promise<{ policy: IAiTrainingPolicy; created: boolean }> {
  const actor = trainingActor(input.user);
  const instruction = cleanInstruction(input.instruction);
  const existing = await AiTrainingPolicy.findOne({
    organizationId: input.organizationId,
    source: 'coaching_submission',
    'sourceRef.messageId': input.messageId,
    'createdBy.userId': actor.userId,
    status: { $in: OPEN_PROPOSAL_STATUSES },
  });
  if (existing) return { policy: existing, created: false };

  const now = new Date();
  const policy = await runTrainingWrite((session) => createPolicyWithFirstVersion({
    organizationId: input.organizationId,
    session,
    policy: {
      title: titleFrom(instruction),
      category: 'behavior',
      channels: [input.channel],
      status: 'in_review',
      source: 'coaching_submission',
      sourceRef: {
        leadId: input.leadId,
        messageId: input.messageId,
        messageModel: input.messageModel,
        channel: input.channel,
        aiLogId: input.aiLogId || undefined,
      },
      ruleFormat: 'instruction',
      submittedVersion: 1,
      createdBy: actor,
      submittedAt: now,
      pendingAudit: [auditEntry('proposal_submitted', actor, { version: 1, toStatus: 'in_review' })],
    },
    version: {
      spec: { instruction },
      originalAiMessageSnapshot: String(input.originalAiMessageSnapshot || '').slice(0, 1200) || undefined,
      changeNote: 'Submitted from Coach your AI',
      createdBy: actor,
    },
  }));
  await flushPolicyAudit(input.organizationId, policy._id);
  return { policy, created: true };
}

type ReviewAction = 'withdraw' | 'request_changes' | 'approve' | 'reject';

const REVIEW_RULES: Record<ReviewAction, {
  from: TrainingPolicyStatus[];
  to: TrainingPolicyStatus;
  reviewerOnly: boolean;
  noteRequired: boolean;
  audit: TrainingAuditAction;
}> = {
  withdraw: { from: ['draft', 'in_review', 'changes_requested'], to: 'withdrawn', reviewerOnly: false, noteRequired: false, audit: 'proposal_withdrawn' },
  request_changes: { from: ['in_review'], to: 'changes_requested', reviewerOnly: true, noteRequired: true, audit: 'proposal_changes_requested' },
  approve: { from: ['in_review'], to: 'approved', reviewerOnly: true, noteRequired: false, audit: 'proposal_approved' },
  reject: { from: ['in_review', 'changes_requested'], to: 'rejected', reviewerOnly: true, noteRequired: true, audit: 'proposal_rejected' },
};

export async function transitionProposal(input: {
  organizationId: string;
  policyId: string;
  user: any;
  action: ReviewAction;
  note?: unknown;
  expectedVersion?: unknown;
}): Promise<IAiTrainingPolicy> {
  const rule = REVIEW_RULES[input.action];
  const actor = trainingActor(input.user);
  const reviewer = canReviewTraining(actor.role as TrainingRole);
  const policy = await loadVisibleProposal(input.organizationId, input.policyId, input.user);
  const isAuthor = policy.createdBy?.userId === actor.userId;

  if (rule.reviewerOnly && !reviewer) throw new ApiError(403, 'Only managers or admins can review training proposals');
  if (!rule.reviewerOnly && !isAuthor && !reviewer) throw new ApiError(403, 'Only the author or a manager can withdraw this proposal');
  if (input.action === 'approve' && isAuthor) throw new ApiError(403, 'You cannot approve your own proposal. Ask another manager or admin to review it.');
  if (input.action === 'approve') {
    const current: any = await AiTrainingPolicyVersion.findOne({ organizationId: input.organizationId, policyId: policy._id, version: policy.currentVersion })
      .select('createdBy').lean();
    if (current?.createdBy?.userId === actor.userId) {
      throw new ApiError(403, 'You edited the current version, so another manager or admin needs to approve it.');
    }
  }
  const note = cleanNote(input.note, rule.noteRequired);
  if (!rule.from.includes(policy.status)) throw new ApiError(409, `This proposal is ${policy.status.replace(/_/g, ' ')} and cannot be changed this way`);
  if (input.expectedVersion !== undefined && input.expectedVersion !== null && Number(input.expectedVersion) !== policy.currentVersion) {
    throw new ApiError(409, 'This proposal has a newer version. Refresh and review the latest version.');
  }
  if (input.action === 'approve') await requirePolicyIntegrity(input.organizationId, policy);

  const now = new Date();
  const set: Record<string, unknown> = {
    status: rule.to,
    lastReview: { action: input.action, note, by: actor, at: now },
  };
  if (input.action === 'approve') {
    set.approvedBy = actor;
    set.approvedAt = now;
  }
  const entry = auditEntry(rule.audit, actor, { version: policy.currentVersion, fromStatus: policy.status, toStatus: rule.to, note });
  const updated = await AiTrainingPolicy.findOneAndUpdate(
    { _id: policy._id, organizationId: input.organizationId, status: policy.status, currentVersion: policy.currentVersion },
    { $set: set, $push: { pendingAudit: entry } },
    { new: true },
  );
  if (!updated) throw new ApiError(409, 'This proposal was just changed by someone else. Refresh and try again.');
  await flushPolicyAudit(input.organizationId, policy._id);
  return updated;
}

export async function reviseProposal(input: {
  organizationId: string;
  policyId: string;
  user: any;
  instruction: unknown;
  changeNote?: unknown;
}): Promise<IAiTrainingPolicy> {
  const actor = trainingActor(input.user);
  const policy = await loadVisibleProposal(input.organizationId, input.policyId, input.user);
  if (policy.createdBy?.userId !== actor.userId) throw new ApiError(403, 'Only the author can revise this proposal');
  if (!['draft', 'changes_requested'].includes(policy.status)) throw new ApiError(409, 'Only proposals that need changes can be revised');
  const instruction = cleanInstruction(input.instruction);
  const changeNote = cleanNote(input.changeNote, false);
  const previous: any = await AiTrainingPolicyVersion.findOne({ organizationId: input.organizationId, policyId: policy._id, version: policy.currentVersion }).lean();
  const now = new Date();
  const snapshot = policy.toObject();

  const { updated } = await runTrainingWrite((session) => appendPolicyVersion({
    organizationId: input.organizationId,
    policy: snapshot,
    session,
    version: {
      spec: { ...(previous?.spec || {}), instruction },
      originalAiMessageSnapshot: previous?.originalAiMessageSnapshot,
      changeNote,
      createdBy: actor,
    },
    set: (version) => ({ status: 'in_review', submittedVersion: version, submittedAt: now, title: titleFrom(instruction), lastEditedBy: actor }),
    audit: (version) => [auditEntry('proposal_revised', actor, { version, fromStatus: snapshot.status, toStatus: 'in_review', note: changeNote })],
  }));
  await flushPolicyAudit(input.organizationId, policy._id);
  return updated;
}

export async function setOrganizationTrainingEnabled(input: { organizationId: string; user: any; enabled: unknown; reason?: unknown }) {
  const actor = trainingActor(input.user);
  if (actor.role !== 'admin') throw new ApiError(403, 'Only admins can turn AI training on or off');
  if (typeof input.enabled !== 'boolean') throw new ApiError(400, 'enabled must be true or false');
  const reason = cleanNote(input.reason, false);
  const org: any = await Organization.findById(input.organizationId).select('metadata').lean();
  if (!org) throw new ApiError(404, 'Organization not found');
  const current = org.metadata?.aiTrainingEnabled === true;
  if (current !== input.enabled) {
    const claimed = await Organization.findOneAndUpdate(
      { _id: input.organizationId, 'metadata.aiTrainingEnabled': current ? true : { $ne: true } },
      { $set: { 'metadata.aiTrainingEnabled': input.enabled } },
    );
    if (!claimed) throw new ApiError(409, 'Someone else just changed this setting. Refresh and try again.');
    try {
      await AiTrainingAuditLog.create({
        organizationId: input.organizationId,
        action: input.enabled ? 'training_enabled' : 'training_disabled',
        actor,
        fromStatus: current ? 'on' : 'off',
        toStatus: input.enabled ? 'on' : 'off',
        note: reason,
      });
    } catch (err: any) {
      await Organization.updateOne(
        { _id: input.organizationId, 'metadata.aiTrainingEnabled': input.enabled },
        { $set: { 'metadata.aiTrainingEnabled': current } },
      ).catch(() => undefined);
      logger.error({ organizationId: input.organizationId, errorName: err?.name }, '[AiTraining] Training switch audit failed; the change was rolled back');
      throw new ApiError(503, 'The change could not be recorded, so the setting was not changed. Try again.');
    }
  }
  return { changed: current !== input.enabled };
}

export async function saveDraftEvaluation(input: {
  organizationId: string;
  draftId: string;
  user: any;
  rating: unknown;
  correctedReply?: unknown;
  reasonTags?: unknown;
  note?: unknown;
}) {
  const actor = trainingActor(input.user);
  if (!canReviewTraining(actor.role as TrainingRole)) throw new ApiError(403, 'Only managers or admins can rate shadow drafts');
  if (!mongoose.isValidObjectId(input.draftId)) throw new ApiError(404, 'Shadow draft not found');
  const rating = String(input.rating || '');
  if (!(DRAFT_EVALUATION_RATINGS as readonly string[]).includes(rating)) throw new ApiError(400, 'Choose a rating: good, needs edit, wrong, or unsafe');
  const correctedReply = String(input.correctedReply || '').trim();
  if (correctedReply.length > MAX_CORRECTED_REPLY_LENGTH) throw new ApiError(400, `Corrected replies can be at most ${MAX_CORRECTED_REPLY_LENGTH} characters`);
  const tags = Array.isArray(input.reasonTags) ? Array.from(new Set(input.reasonTags.map(String))) : [];
  if (tags.some((tag) => !(DRAFT_EVALUATION_TAGS as readonly string[]).includes(tag))) throw new ApiError(400, 'Unknown reason tag');
  const note = cleanNote(input.note, false);

  const draft = await AiAgentDraft.findOne({ _id: input.draftId, organizationId: input.organizationId }).select('_id').lean();
  if (!draft) throw new ApiError(404, 'Shadow draft not found');

  const evaluation = await AiDraftEvaluation.findOneAndUpdate(
    { organizationId: input.organizationId, draftId: input.draftId, 'evaluator.userId': actor.userId },
    {
      $set: {
        rating,
        correctedReply: correctedReply || undefined,
        reasonTags: tags,
        note,
        'evaluator.name': actor.name,
        'evaluator.role': actor.role,
        expiresAt: new Date(Date.now() + DRAFT_EVALUATION_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  await writeTrainingAudit({
    organizationId: input.organizationId,
    action: 'draft_evaluated',
    actor,
    draftId: input.draftId,
    evaluationId: evaluation?._id,
    toStatus: rating,
  });
  return evaluation;
}
