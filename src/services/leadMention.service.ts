import mongoose from 'mongoose';
import LeadMention from '../models/LeadMention.model';
import Lead from '../models/lead.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import CrmLeadGroup from '../models/CrmLeadGroup.model';
import { resolveCrmStaff } from '../utils/crmStaff';
import { samePersonIds } from '../utils/samePersonIds';
import { cleanSearchText, escapeSearchRegex, phoneSearchDigits } from '../utils/searchText';

export const MENTION_TEXT_LIMIT = 500;
export const MENTION_BACKFILL_NEW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const VIEWER_IDS_TTL_MS = 60 * 1000;
const viewerIdsCache = new Map<string, { ids: string[]; until: number }>();

export type LeadMentionStatus = 'new' | 'completed' | 'all';

export interface MentionNote {
  _id: unknown;
  text?: string;
  createdAt?: Date;
  createdBy?: unknown;
  authorType?: string;
  authorName?: string;
  mentionedUserIds?: unknown[];
  mentionedGroupIds?: unknown[];
  sourceTaskId?: unknown;
}

const objectId = (id: unknown) => new mongoose.Types.ObjectId(String(id));
const validIds = (ids: unknown[] | undefined) => [...new Set((ids || []).map(String))].filter((id) => mongoose.isValidObjectId(id));
const plainSentence = (value: unknown) => String(value ?? '').trim().replace(/[.!?]+$/, '').toLowerCase();

async function mainPersonId(organizationId: string, id: string): Promise<string | null> {
  if (await User.exists({ _id: id, organizationId })) return id;
  const crmUser: any = await CrmUser.findOne({ _id: id, organizationId }).select('email').lean();
  if (!crmUser) return null;
  const email = String(crmUser.email || '').trim().toLowerCase();
  const user: any = email ? await User.findOne({ organizationId, email }).select('_id').lean() : null;
  return user ? String(user._id) : id;
}

export function isTeamRoutingTag(note: MentionNote): boolean {
  return note.authorType === 'ai'
    && !validIds(note.mentionedUserIds).length
    && validIds(note.mentionedGroupIds).length > 0
    && !note.sourceTaskId;
}

async function hasHandoffTask(leadIds: unknown[], note: MentionNote): Promise<boolean> {
  const at = new Date(note.createdAt || 0).getTime();
  const text = plainSentence(note.text);
  if (!at || !text) return false;
  const { default: AiAgentTask } = await import('../models/AiAgentTask.model');
  const tasks: any[] = await AiAgentTask.find({
    leadId: { $in: leadIds },
    attentionKind: null,
    createdAt: { $gte: new Date(at - 5 * 60 * 1000), $lte: new Date(at) },
  })
    .select('question')
    .lean();
  return tasks.some((task) => {
    const question = plainSentence(task.question);
    return Boolean(question) && text.includes(question);
  });
}

export async function buildLeadMentionRows(organizationId: string, leadId: string, note: MentionNote) {
  const people = new Map<string, { via: 'person' | 'team'; groupId: string | null; groupName: string }>();
  for (const id of validIds(note.mentionedUserIds)) {
    const personId = await mainPersonId(organizationId, id);
    if (personId && !people.has(personId)) people.set(personId, { via: 'person', groupId: null, groupName: '' });
  }

  const groupIds = validIds(note.mentionedGroupIds);
  if (groupIds.length) {
    const groups: any[] = await CrmLeadGroup.find({ _id: { $in: groupIds }, organizationId, isActive: true })
      .select('name memberIds')
      .lean();
    const memberIds = validIds(groups.flatMap((group) => group.memberIds || []));
    const active = new Set(
      (await User.find({ _id: { $in: memberIds }, organizationId, isActive: true }).select('_id').lean())
        .map((user: any) => String(user._id)),
    );
    for (const group of groups) {
      for (const memberId of validIds(group.memberIds)) {
        if (active.has(memberId) && !people.has(memberId)) {
          people.set(memberId, { via: 'team', groupId: String(group._id), groupName: String(group.name || 'Team').trim().slice(0, 120) });
        }
      }
    }
  }

  if (!people.size) return [];
  const author = note.createdBy ? new Set(await samePersonIds(organizationId, String(note.createdBy))) : new Set<string>();
  return [...people.entries()]
    .filter(([userId]) => !author.has(userId))
    .map(([userId, how]) => ({
      organizationId: objectId(organizationId),
      leadId: objectId(leadId),
      noteId: objectId(note._id),
      userId: objectId(userId),
      via: how.via,
      groupId: how.groupId ? objectId(how.groupId) : null,
      groupName: how.groupName,
      authorName: String(note.authorName || '').slice(0, 160),
      authorType: String(note.authorType || 'user').slice(0, 20),
      text: String(note.text || '').slice(0, MENTION_TEXT_LIMIT),
      mentionedAt: note.createdAt ? new Date(note.createdAt) : new Date(),
    }));
}

async function saveMentionRows(rows: Awaited<ReturnType<typeof buildLeadMentionRows>>, completedAt: Date | null): Promise<number> {
  if (!rows.length) return 0;
  const result = await LeadMention.bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { noteId: row.noteId, userId: row.userId },
        update: { $setOnInsert: { ...row, completedAt } },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return result.upsertedCount || 0;
}

export async function recordLeadMentions(organizationId: string, leadId: string, note: MentionNote): Promise<number> {
  return saveMentionRows(await buildLeadMentionRows(organizationId, leadId, note), null);
}

export async function viewerMentionIds(organizationId: string, crmUser: any): Promise<mongoose.Types.ObjectId[]> {
  const key = `${organizationId}:${String(crmUser?._id || '')}`;
  const cached = viewerIdsCache.get(key);
  if (cached && cached.until > Date.now()) return cached.ids.map(objectId);
  const staff = await resolveCrmStaff(organizationId, crmUser);
  const ids = new Set<string>();
  for (const id of [staff.userId, staff.actorId].filter(Boolean) as string[]) {
    for (const same of await samePersonIds(organizationId, id)) ids.add(same);
  }
  const list = [...ids].filter((id) => mongoose.isValidObjectId(id));
  if (viewerIdsCache.size > 5000) viewerIdsCache.clear();
  viewerIdsCache.set(key, { ids: list, until: Date.now() + VIEWER_IDS_TTL_MS });
  return list.map(objectId);
}

export function forgetMentionViewers(): void {
  viewerIdsCache.clear();
}

const MENTION_LEAD_FIELDS: Record<string, 1> = { firstName: 1, lastName: 1, phone: 1, email: 1, status: 1, channel: 1 };

const MENTION_SEARCH_FIELDS = ['text', 'authorName', 'groupName', 'lead.firstName', 'lead.lastName', 'lead.phone', 'lead.email'];
const inAnyMentionField = (pattern: string) => MENTION_SEARCH_FIELDS.map((field) => ({ [field]: { $regex: pattern, $options: 'i' } }));

export function mentionSearchCondition(raw: unknown): Record<string, unknown> | null {
  const search = cleanSearchText(raw, 80);
  if (!search) return null;
  const digits = phoneSearchDigits(search);
  if (digits) {
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    return { $or: [{ 'lead.phone': { $regex: national.split('').join('\\D*') } }, ...inAnyMentionField(escapeSearchRegex(search))] };
  }
  const words = search.split(' ').slice(0, 6);
  const patternFor = (word: string) => {
    const escaped = escapeSearchRegex(word);
    return words.length > 1 && word.length <= 2 ? `\\b${escaped}` : escaped;
  };
  return { $and: words.map((word) => ({ $or: inAnyMentionField(patternFor(word)) })) };
}

const leadLookup = (fields: Record<string, 1>) => ({
  $lookup: {
    from: Lead.collection.name,
    localField: 'leadId',
    foreignField: '_id',
    as: 'lead',
    pipeline: [{ $project: fields }],
  },
});

export async function listLeadMentions(
  organizationId: string,
  crmUser: any,
  options: { status?: unknown; q?: unknown; page?: unknown; limit?: unknown } = {},
) {
  const status: LeadMentionStatus = options.status === 'completed' || options.status === 'all' ? options.status : 'new';
  const page = Math.max(1, Math.floor(Number(options.page) || 1));
  const limit = Math.min(50, Math.max(1, Math.floor(Number(options.limit) || 20)));
  const asOf = new Date().toISOString();
  const ids = await viewerMentionIds(organizationId, crmUser);
  if (!ids.length) return { items: [], total: 0, page, pages: 1, status, asOf };

  const match: Record<string, unknown> = { organizationId: objectId(organizationId), userId: { $in: ids } };
  if (status === 'new') match.completedAt = null;
  if (status === 'completed') match.completedAt = { $ne: null };
  const search = mentionSearchCondition(options.q);

  const pageStages = [{ $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }] } }];
  let rows: any[] = [];
  let total = 0;
  if (search) {
    const [result] = await LeadMention.aggregate([
      { $match: match },
      { $sort: { mentionedAt: -1, _id: -1 } },
      leadLookup(MENTION_LEAD_FIELDS),
      { $unwind: '$lead' },
      { $match: search },
      ...pageStages,
    ]);
    rows = result?.items || [];
    total = Number(result?.total?.[0]?.n || 0);
  } else {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const [result] = await LeadMention.aggregate([{ $match: match }, { $sort: { mentionedAt: -1, _id: -1 } }, ...pageStages]);
      const pageRows: any[] = result?.items || [];
      const leads = await Lead.find({ _id: { $in: pageRows.map((row) => row.leadId) } }).select(Object.keys(MENTION_LEAD_FIELDS).join(' ')).lean();
      const byId = new Map(leads.map((lead: any) => [String(lead._id), lead]));
      const orphans = pageRows.filter((row) => !byId.has(String(row.leadId)));
      const removed = orphans.length
        ? (await LeadMention.deleteMany({ _id: { $in: orphans.map((row) => row._id) } }).catch(() => null))?.deletedCount || 0
        : 0;
      rows = pageRows.filter((row) => byId.has(String(row.leadId))).map((row) => ({ ...row, lead: byId.get(String(row.leadId)) }));
      total = Math.max(0, Number(result?.total?.[0]?.n || 0) - orphans.length);
      if (!removed) break;
    }
  }

  const items = rows.map((row: any) => {
    const firstName = String(row.lead?.firstName || '');
    const lastName = String(row.lead?.lastName || '');
    return {
      id: String(row._id),
      leadId: String(row.leadId),
      noteId: String(row.noteId),
      firstName,
      lastName,
      customerName: [firstName, lastName].filter(Boolean).join(' ').trim() || row.lead?.phone || row.lead?.email || 'Customer',
      phone: String(row.lead?.phone || ''),
      email: String(row.lead?.email || ''),
      status: String(row.lead?.status || ''),
      channel: String(row.lead?.channel || ''),
      via: row.via,
      teamName: String(row.groupName || ''),
      authorName: String(row.authorName || ''),
      authorType: String(row.authorType || 'user'),
      text: String(row.text || ''),
      mentionedAt: row.mentionedAt,
      completedAt: row.completedAt || null,
    };
  });
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)), status, asOf };
}

export async function countNewLeadMentions(organizationId: string, crmUser: any): Promise<number> {
  const ids = await viewerMentionIds(organizationId, crmUser);
  if (!ids.length) return 0;
  return LeadMention.countDocuments({ organizationId: objectId(organizationId), userId: { $in: ids }, completedAt: null });
}

export async function completeLeadMentions(
  organizationId: string,
  crmUser: any,
  input: { all?: unknown; mentionId?: unknown; noteId?: unknown; before?: unknown } = {},
): Promise<number> {
  const filter: Record<string, unknown> = { organizationId: objectId(organizationId), completedAt: null };
  if (input.all === true) {
    const before = input.before ? new Date(String(input.before)) : null;
    if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lte: before };
  } else {
    if (mongoose.isValidObjectId(String(input.mentionId || ''))) filter._id = objectId(input.mentionId);
    else if (mongoose.isValidObjectId(String(input.noteId || ''))) filter.noteId = objectId(input.noteId);
    else return 0;
  }
  const ids = await viewerMentionIds(organizationId, crmUser);
  if (!ids.length) return 0;
  filter.userId = { $in: ids };
  const result = await LeadMention.updateMany(filter, { $set: { completedAt: new Date() } });
  return result.modifiedCount || 0;
}

export async function runLeadMentionBackfill(options: { apply: boolean; organizationId?: string; now?: Date }) {
  const now = options.now || new Date();
  const newFrom = now.getTime() - MENTION_BACKFILL_NEW_DAYS * DAY_MS;
  const filter: Record<string, unknown> = {
    $or: [{ 'notes.mentionedUserIds.0': { $exists: true } }, { 'notes.mentionedGroupIds.0': { $exists: true } }],
  };
  if (options.organizationId) filter.organizationId = objectId(options.organizationId);

  const summary = { leads: 0, notes: 0, skippedTeamTags: 0, people: 0, startNew: 0, startCompleted: 0, alreadySaved: 0, saved: 0 };
  const cursor = Lead.find(filter).select('organizationId notes combinedInto').lean().cursor();
  for await (const lead of cursor as any) {
    summary.leads += 1;
    const taskLeadIds = [lead._id, lead.combinedInto?.leadId].filter(Boolean);
    for (const note of (lead.notes || []) as MentionNote[]) {
      if (!validIds(note.mentionedUserIds).length && !validIds(note.mentionedGroupIds).length) continue;
      if (isTeamRoutingTag(note) && !(await hasHandoffTask(taskLeadIds, note))) {
        summary.skippedTeamTags += 1;
        continue;
      }
      summary.notes += 1;
      const rows = await buildLeadMentionRows(String(lead.organizationId), String(lead._id), note);
      if (!rows.length) continue;
      const existing = new Set(
        (await LeadMention.find({ noteId: rows[0].noteId, userId: { $in: rows.map((row) => row.userId) } }).select('userId').lean())
          .map((row: any) => String(row.userId)),
      );
      const fresh = rows.filter((row) => !existing.has(String(row.userId)));
      summary.alreadySaved += rows.length - fresh.length;
      summary.people += fresh.length;
      const startsNew = new Date(note.createdAt || 0).getTime() >= newFrom;
      if (startsNew) summary.startNew += fresh.length;
      else summary.startCompleted += fresh.length;
      if (options.apply && fresh.length) summary.saved += await saveMentionRows(fresh, startsNew ? null : now);
    }
  }
  return summary;
}
