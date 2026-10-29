import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import Lead from '../models/lead.model';
import Appointment from '../models/Appointment.model';
import AiAgentTask from '../models/AiAgentTask.model';
import { Conversation } from '../models/communication.model';
import LeadCombineRun from '../models/LeadCombineRun.model';
import LeadCombineRecord from '../models/LeadCombineRecord.model';
import LeadIntakeAudit from '../models/LeadIntakeAudit.model';
import LeadIntakeControl from '../models/LeadIntakeControl.model';
import { LIFECYCLE_ACTIVE_STATUSES } from '../constants/leadStatus';
import { effectiveContact } from './leadLifecycle.service';
import { newestFirst } from './leadIntakeDecision';
import { leadIntakeLockKeys, withLeadIntakeLock } from './leadIntakeLock.service';
import { getLeadIntakeMode, onLeadIntakeResumed } from './leadIntakeControl.service';
import { emitToOrg } from '../utils/socketEmitter';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';

export const MAX_COMBINE_GROUP_SIZE = 10;
const MAX_SCANNED_LEADS = 50_000;
const RUN_LEASE_MS = 10 * 60 * 1000;
export const MAX_COMBINE_RUN_ATTEMPTS = 3;
const UPCOMING_APPOINTMENT_STATUSES = ['scheduled', 'confirmed'];
const GROUP_FIELDS = '_id phone email normalizedPhone normalizedEmail identityEmailExcluded createdAt';
const COMBINE_FIELDS = `${GROUP_FIELDS} status assignedTo inquiryCount lastInquiryAt`;

export interface GroupableLead {
  leadId: string;
  phone: string | null;
  email: string | null;
  createdAt?: Date | null;
}

export interface CombineResult {
  mainLeadId: string;
  combinedLeadIds: string[];
}

const toGroupable = (doc: any): GroupableLead => {
  const contact = effectiveContact(doc);
  return {
    leadId: String(doc._id),
    phone: contact.normalizedPhone,
    email: contact.normalizedEmail,
    createdAt: doc.createdAt ? new Date(doc.createdAt) : null,
  };
};

export function groupDuplicateLeads(leads: GroupableLead[]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let current = id;
    while (parent.get(current) !== root) {
      const next = parent.get(current) as string;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const byId = new Map<string, GroupableLead>();
  for (const lead of leads) {
    byId.set(lead.leadId, lead);
    parent.set(lead.leadId, lead.leadId);
  }
  const keyOwner = new Map<string, string>();
  for (const lead of byId.values()) {
    for (const key of [lead.phone ? `phone:${lead.phone}` : null, lead.email ? `email:${lead.email}` : null]) {
      if (!key) continue;
      const owner = keyOwner.get(key);
      if (!owner) {
        keyOwner.set(key, lead.leadId);
        continue;
      }
      const a = find(lead.leadId);
      const b = find(owner);
      if (a !== b) parent.set(a, b);
    }
  }
  const groups = new Map<string, GroupableLead[]>();
  for (const lead of byId.values()) {
    const root = find(lead.leadId);
    groups.set(root, [...(groups.get(root) || []), lead]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort(newestFirst).map((lead) => lead.leadId));
}

async function loadGroupableLeads(organizationId: string) {
  const docs = await Lead.find({
    organizationId,
    status: { $in: LIFECYCLE_ACTIVE_STATUSES },
    intakeIdentity: { $ne: 'unverified' },
    'combinedInto.leadId': { $exists: false },
  })
    .select(GROUP_FIELDS)
    .limit(MAX_SCANNED_LEADS + 1)
    .lean();
  return { leads: docs.slice(0, MAX_SCANNED_LEADS).map(toGroupable), complete: docs.length <= MAX_SCANNED_LEADS };
}

export async function previewDuplicateLeads(organizationId: string) {
  const { leads, complete } = await loadGroupableLeads(organizationId);
  const groups = groupDuplicateLeads(leads);
  const ready = groups.filter((group) => group.length <= MAX_COMBINE_GROUP_SIZE);
  return {
    customers: ready.length,
    leads: ready.reduce((total, group) => total + group.length - 1, 0),
    skippedGroups: groups.length - ready.length,
    complete,
  };
}

function lockKeysFor(docs: any[]): string[] {
  const keys = new Set<string>();
  for (const doc of docs) {
    const contact = effectiveContact(doc);
    for (const key of leadIntakeLockKeys({ phone: contact.normalizedPhone, email: contact.normalizedEmail })) keys.add(key);
  }
  return [...keys];
}

async function moveRecords(model: any, filter: Record<string, unknown>, mainLeadId: mongoose.Types.ObjectId) {
  const found: any[] = await model.find(filter).select('_id leadId').lean();
  if (found.length) await model.updateMany({ _id: { $in: found.map((entry) => entry._id) } }, { $set: { leadId: mainLeadId } });
  return found.map((entry) => ({ id: entry._id, fromLeadId: entry.leadId }));
}

async function combineWithinLock(
  organizationId: string,
  docs: any[],
  options: { runId?: string | null; confirmHeld: () => Promise<void> },
): Promise<CombineResult | null> {
  const ordered = [...docs].sort((a, b) => newestFirst(toGroupable(a), toGroupable(b)));
  const main = ordered[0];
  const duplicates = ordered.slice(1);
  if (!main || !duplicates.length) return null;
  await options.confirmHeld();
  const record = await LeadCombineRecord.create({
    organizationId,
    runId: options.runId || null,
    mainLeadId: main._id,
    combinedLeads: duplicates.map((doc) => ({ leadId: doc._id, previousStatus: doc.status })),
    moved: { appointments: [], aiTasks: [], conversations: [] },
    mainBefore: { assignedTo: main.assignedTo || null, inquiryCount: main.inquiryCount ?? null },
    mainAfter: {},
    state: 'applying',
  });

  const now = new Date();
  const combined: any[] = [];
  for (const doc of duplicates) {
    const result = await Lead.updateOne(
      { _id: doc._id, organizationId, status: doc.status, 'combinedInto.leadId': { $exists: false } },
      {
        $set: { status: 'Closed', combinedInto: { leadId: main._id, at: now, previousStatus: doc.status } },
        $push: { statusHistory: { from: doc.status, to: 'Closed', changedAt: now, reason: `Combined into lead ${main._id}` } },
      },
    );
    if (result.modifiedCount === 1) combined.push(doc);
  }
  if (!combined.length) {
    await LeadCombineRecord.deleteOne({ _id: record._id });
    return null;
  }

  const combinedIds = combined.map((doc) => doc._id);
  const orgIds = { $in: [organizationId, new mongoose.Types.ObjectId(organizationId)] };
  const [appointments, aiTasks, conversations] = await Promise.all([
    moveRecords(Appointment, {
      organizationId: String(organizationId),
      leadId: { $in: combinedIds },
      status: { $in: UPCOMING_APPOINTMENT_STATUSES },
      startTime: { $gte: now },
    }, main._id),
    moveRecords(AiAgentTask, { organizationId: String(organizationId), leadId: { $in: combinedIds }, status: 'pending' }, main._id),
    moveRecords(Conversation, { orgId: orgIds, leadId: { $in: combinedIds } }, main._id),
  ]);

  const inquiryCount = [main, ...combined].reduce((total, doc) => total + (doc.inquiryCount || 1), 0);
  const lastInquiryAt = [main, ...combined]
    .map((doc) => new Date(doc.lastInquiryAt || doc.createdAt || 0).getTime())
    .reduce((latest, time) => Math.max(latest, time), 0);
  const newAssignee = main.assignedTo ? null : combined.find((doc) => doc.assignedTo)?.assignedTo || null;
  const mainContact = effectiveContact(main);
  const phoneDonor = !mainContact.normalizedPhone && !String(main.phone || '').trim()
    ? combined.find((doc) => effectiveContact(doc).normalizedPhone)
    : null;
  const emailDonor = !main.identityEmailExcluded && !mainContact.normalizedEmail && !String(main.email || '').trim()
    ? combined.find((doc) => effectiveContact(doc).normalizedEmail)
    : null;
  const filledContact = { phone: phoneDonor ? String(phoneDonor.phone) : null, email: emailDonor ? String(emailDonor.email) : null };
  await Lead.findOneAndUpdate(
    { _id: main._id, organizationId },
    {
      $set: {
        inquiryCount,
        ...(lastInquiryAt ? { lastInquiryAt: new Date(lastInquiryAt) } : {}),
        ...(newAssignee ? { assignedTo: newAssignee, assignedAt: now } : {}),
        ...(phoneDonor ? { phone: phoneDonor.phone, normalizedPhone: effectiveContact(phoneDonor).normalizedPhone } : {}),
        ...(emailDonor ? { email: emailDonor.email, normalizedEmail: effectiveContact(emailDonor).normalizedEmail } : {}),
      },
      ...(newAssignee ? { $push: { assignmentHistory: { from: null, to: newAssignee, changedAt: now } } } : {}),
    },
  );

  await LeadCombineRecord.updateOne(
    { _id: record._id },
    {
      $set: {
        state: 'applied',
        combinedLeads: combined.map((doc) => ({ leadId: doc._id, previousStatus: doc.status })),
        moved: { appointments, aiTasks, conversations },
        mainAfter: { assignedTo: newAssignee || main.assignedTo || null, inquiryCount },
        filledContact,
      },
    },
  );
  await LeadIntakeAudit.create({
    organizationId,
    event: 'duplicates_combined',
    actor: { kind: 'system', userId: null, name: 'Automatic lead matching' },
    leadId: main._id,
    reason: `Combined ${combined.length} duplicate ${combined.length === 1 ? 'lead' : 'leads'} into this lead: ${combinedIds.map(String).join(', ')}`,
  });
  for (const id of [main._id, ...combinedIds]) {
    emitToOrg(organizationId, 'lead:update', { _id: String(id), leadId: String(id) });
  }
  return { mainLeadId: String(main._id), combinedLeadIds: combinedIds.map(String) };
}

export async function combineLeadGroup(
  organizationId: string,
  leadIds: string[],
  options: { runId?: string | null } = {},
): Promise<CombineResult[]> {
  const docs = await Lead.find({ _id: { $in: leadIds }, organizationId }).select(GROUP_FIELDS).lean();
  const keys = lockKeysFor(docs);
  if (docs.length < 2 || !keys.length) return [];
  return withLeadIntakeLock(organizationId, keys, async ({ confirmHeld }) => {
    const fresh = await Lead.find({
      _id: { $in: leadIds },
      organizationId,
      status: { $in: LIFECYCLE_ACTIVE_STATUSES },
      intakeIdentity: { $ne: 'unverified' },
      'combinedInto.leadId': { $exists: false },
    })
      .select(COMBINE_FIELDS)
      .lean();
    const byId = new Map(fresh.map((doc: any) => [String(doc._id), doc]));
    const results: CombineResult[] = [];
    for (const group of groupDuplicateLeads(fresh.map(toGroupable))) {
      if (group.length > MAX_COMBINE_GROUP_SIZE) continue;
      const result = await combineWithinLock(organizationId, group.map((id) => byId.get(id)), { runId: options.runId, confirmHeld });
      if (result) results.push(result);
    }
    return results;
  });
}

async function claimRun(organizationId: string, owner: string) {
  const now = new Date();
  const lease = { state: 'running' as const, owner, leaseUntil: new Date(now.getTime() + RUN_LEASE_MS), startedAt: now };
  const reclaimed = await LeadCombineRun.findOneAndUpdate(
    {
      organizationId,
      $or: [
        { state: 'failed', attempts: { $lt: MAX_COMBINE_RUN_ATTEMPTS } },
        { state: 'running', leaseUntil: { $lt: now } },
      ],
    },
    { $set: lease, $inc: { attempts: 1 } },
    { new: true },
  );
  if (reclaimed) return reclaimed;
  if (await LeadCombineRun.exists({ organizationId })) return null;
  try {
    return await LeadCombineRun.create({ organizationId, ...lease, attempts: 1 });
  } catch (err: any) {
    if (err?.code === 11000) return null;
    throw err;
  }
}

export async function runDuplicateCombine(organizationId: string) {
  if (String(process.env.LEAD_DUPLICATE_COMBINE || '').toLowerCase() === 'off') return null;
  if (!mongoose.isValidObjectId(organizationId)) return null;
  if ((await getLeadIntakeMode(organizationId)) !== 'active') return null;
  const owner = randomUUID();
  const run = await claimRun(organizationId, owner);
  if (!run) return null;
  const stats = { customers: 0, leadsCombined: 0, skippedGroups: 0, failedGroups: 0, complete: true };
  try {
    const { leads, complete } = await loadGroupableLeads(organizationId);
    stats.complete = complete;
    for (const group of groupDuplicateLeads(leads)) {
      if (group.length > MAX_COMBINE_GROUP_SIZE) {
        stats.skippedGroups += 1;
        continue;
      }
      await LeadCombineRun.updateOne({ _id: run._id, owner }, { $set: { leaseUntil: new Date(Date.now() + RUN_LEASE_MS) } });
      try {
        for (const result of await combineLeadGroup(organizationId, group, { runId: String(run._id) })) {
          stats.customers += 1;
          stats.leadsCombined += result.combinedLeadIds.length;
        }
      } catch (err) {
        stats.failedGroups += 1;
        logger.warn({ err, organizationId, leadIds: group }, '[LeadCombine] A duplicate group could not be combined');
      }
    }
    const retry = stats.failedGroups > 0 && run.attempts < MAX_COMBINE_RUN_ATTEMPTS;
    await LeadCombineRun.updateOne(
      { _id: run._id, owner },
      {
        $set: {
          state: retry ? 'failed' : 'done',
          finishedAt: new Date(),
          leaseUntil: null,
          skippedGroups: stats.skippedGroups,
          failedGroups: stats.failedGroups,
          error: stats.failedGroups
            ? `${stats.failedGroups} duplicate ${stats.failedGroups === 1 ? 'group' : 'groups'} could not be combined`
            : complete ? null : 'Only the first 50,000 open leads were checked',
        },
        $inc: { customers: stats.customers, leadsCombined: stats.leadsCombined },
      },
    );
    logger.info({ organizationId, ...stats }, '[LeadCombine] Duplicate leads combined');
    return stats;
  } catch (err: any) {
    await LeadCombineRun.updateOne(
      { _id: run._id, owner },
      { $set: { state: 'failed', leaseUntil: null, error: String(err?.message || err).slice(0, 500) }, $inc: { customers: stats.customers, leadsCombined: stats.leadsCombined } },
    ).catch(() => undefined);
    throw err;
  }
}

export async function runPendingDuplicateCombines() {
  const controls = await LeadIntakeControl.find({ mode: 'active' }).select('organizationId').lean();
  const results: Array<{ organizationId: string; stats: unknown }> = [];
  for (const control of controls) {
    const organizationId = String(control.organizationId);
    const stats = await runDuplicateCombine(organizationId).catch((err) => {
      logger.error({ err, organizationId }, '[LeadCombine] Duplicate combine failed');
      return null;
    });
    if (stats) results.push({ organizationId, stats });
  }
  return results;
}

export async function getDuplicateCombineStatus(organizationId: string) {
  const run: any = await LeadCombineRun.findOne({ organizationId }).lean();
  const summary = run
    ? {
        state: run.state,
        finishedAt: run.finishedAt || null,
        customers: run.customers || 0,
        leadsCombined: run.leadsCombined || 0,
        skippedGroups: run.skippedGroups || 0,
        failedGroups: run.failedGroups || 0,
      }
    : null;
  if (run?.state === 'done') return { run: summary, preview: null };
  return { run: summary, preview: await previewDuplicateLeads(organizationId) };
}

export async function combineInfoForLead(organizationId: string, lead: any) {
  if (lead?.combinedInto?.leadId) {
    const main: any = await Lead.findOne({ _id: lead.combinedInto.leadId, organizationId }).select('firstName lastName').lean();
    return {
      combinedInto: {
        leadId: String(lead.combinedInto.leadId),
        name: main ? [main.firstName, main.lastName].filter(Boolean).join(' ').trim() || 'Lead' : 'Lead',
        at: lead.combinedInto.at,
      },
    };
  }
  const record: any = await LeadCombineRecord.findOne({ organizationId, mainLeadId: lead._id, state: 'applied' })
    .sort({ createdAt: -1 })
    .select('combinedLeads createdAt')
    .lean();
  return record ? { combined: { count: record.combinedLeads.length, at: record.createdAt } } : null;
}

export async function undoLeadCombine(
  organizationId: string,
  leadId: string,
  actor: { userId?: string | null; name?: string | null },
) {
  if (!mongoose.isValidObjectId(leadId)) throw new ApiError(404, 'Lead not found');
  const record: any = await LeadCombineRecord.findOne({
    organizationId,
    state: 'applied',
    $or: [{ mainLeadId: leadId }, { 'combinedLeads.leadId': leadId }],
  })
    .sort({ createdAt: -1 })
    .lean();
  if (!record) throw new ApiError(404, 'There is no combined lead to undo here.');
  const leadIds = [record.mainLeadId, ...record.combinedLeads.map((entry: any) => entry.leadId)];
  const docs = await Lead.find({ _id: { $in: leadIds }, organizationId }).select(GROUP_FIELDS).lean();
  const keys = lockKeysFor(docs);
  const run = async () => {
    const now = new Date();
    const claimed = await LeadCombineRecord.findOneAndUpdate(
      { _id: record._id, state: 'applied' },
      { $set: { state: 'undone', undoneAt: now, undoneBy: { userId: actor.userId || null, name: actor.name || null } } },
      { new: true },
    );
    if (!claimed) throw new ApiError(409, 'This combine was already undone.');
    const changedBy = actor.userId && mongoose.isValidObjectId(actor.userId) ? new mongoose.Types.ObjectId(actor.userId) : undefined;
    const restored: string[] = [];
    for (const entry of record.combinedLeads) {
      const result = await Lead.updateOne(
        { _id: entry.leadId, organizationId, 'combinedInto.leadId': record.mainLeadId },
        {
          $set: { status: entry.previousStatus },
          $unset: { combinedInto: 1 },
          $push: { statusHistory: { from: 'Closed', to: entry.previousStatus, changedAt: now, ...(changedBy ? { changedBy } : {}), reason: 'Combine undone' } },
        },
      );
      if (result.modifiedCount === 1) restored.push(String(entry.leadId));
    }
    const moveBack = async (model: any, moves: any[]) => {
      for (const move of moves) {
        await model.updateOne({ _id: move.id, leadId: record.mainLeadId }, { $set: { leadId: move.fromLeadId } });
      }
    };
    await moveBack(Appointment, record.moved?.appointments || []);
    await moveBack(AiAgentTask, record.moved?.aiTasks || []);
    await moveBack(Conversation, record.moved?.conversations || []);

    const main: any = await Lead.findOne({ _id: record.mainLeadId, organizationId }).select('inquiryCount assignedTo phone email').lean();
    if (main) {
      const set: Record<string, unknown> = {};
      const unset: Record<string, 1> = {};
      if (main.inquiryCount === record.mainAfter?.inquiryCount) {
        if (record.mainBefore?.inquiryCount == null) unset.inquiryCount = 1;
        else set.inquiryCount = record.mainBefore.inquiryCount;
      }
      const assignedByCombine = record.mainAfter?.assignedTo && String(record.mainAfter.assignedTo) !== String(record.mainBefore?.assignedTo || '');
      if (assignedByCombine && String(main.assignedTo || '') === String(record.mainAfter.assignedTo)) {
        if (record.mainBefore?.assignedTo) set.assignedTo = record.mainBefore.assignedTo;
        else unset.assignedTo = 1;
      }
      if (record.filledContact?.phone && main.phone === record.filledContact.phone) {
        unset.phone = 1;
        unset.normalizedPhone = 1;
      }
      if (record.filledContact?.email && main.email === record.filledContact.email) {
        unset.email = 1;
        unset.normalizedEmail = 1;
      }
      if (Object.keys(set).length || Object.keys(unset).length) {
        await Lead.findOneAndUpdate(
          { _id: record.mainLeadId, organizationId },
          { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
        );
      }
    }
    await LeadIntakeAudit.create({
      organizationId,
      event: 'duplicates_uncombined',
      actor: { kind: 'staff', userId: actor.userId || null, name: actor.name || null },
      leadId: record.mainLeadId,
      reason: `Undid the combine of ${restored.length} ${restored.length === 1 ? 'lead' : 'leads'}: ${restored.join(', ')}`,
    });
    for (const id of [String(record.mainLeadId), ...restored]) {
      emitToOrg(organizationId, 'lead:update', { _id: id, leadId: id });
    }
    return { mainLeadId: String(record.mainLeadId), restoredLeadIds: restored };
  };
  return keys.length ? withLeadIntakeLock(organizationId, keys, run) : run();
}

onLeadIntakeResumed((organizationId) => {
  runDuplicateCombine(organizationId).catch((err) =>
    logger.error({ err, organizationId }, '[LeadCombine] Duplicate combine after turning matching on failed'));
});
