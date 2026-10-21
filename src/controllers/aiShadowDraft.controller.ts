import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import Organization from '../models/Organization.model';
import AiAgentDraft, { AI_DRAFT_CHANNELS, AI_DRAFT_STATUSES } from '../models/AiAgentDraft.model';
import AiUsageCounter from '../models/AiUsageCounter.model';
import Lead from '../models/lead.model';
import WebChatSession from '../models/WebChatSession.model';
import WebChatMessage from '../models/WebChatMessage.model';
import { CommunicationMessage } from '../models/communication.model';
import {
  canViewShadowDrafts,
  resolveOrgTimezone,
  shadowDraftUsageDay,
  SHADOW_DRAFT_DAILY_LIMIT,
} from '../services/aiShadowDraft.service';

const DISPLAY_STATUSES = [...AI_DRAFT_STATUSES, 'interrupted'] as const;
type DisplayStatus = (typeof DISPLAY_STATUSES)[number];
const IN_PROGRESS = ['claimed', 'generating'];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_PAGE = 1000;
const CONTEXT_MESSAGES = 12;
const MAX_BODY = 1000;
const PREVIEW_LENGTH = 160;
const AI_AGENT_ACTOR_ID = 'ai-agent';

function viewer(req: Request): { orgId: string; role: string } {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  if (!canViewShadowDrafts(user.role)) throw new ApiError(403, 'Only managers and admins can view shadow drafts');
  return { orgId, role: String(user.role) };
}

function orgIdVariants(orgId: string): any[] {
  return mongoose.isValidObjectId(orgId) ? [orgId, new mongoose.Types.ObjectId(orgId)] : [orgId];
}

function displayStatus(draft: any, now: Date): DisplayStatus {
  if (IN_PROGRESS.includes(draft.status) && (!draft.leaseExpiresAt || new Date(draft.leaseExpiresAt).getTime() < now.getTime())) {
    return 'interrupted';
  }
  return draft.status;
}

function statusFilter(status: DisplayStatus, now: Date): Record<string, unknown> {
  if (status === 'interrupted') {
    return { status: { $in: IN_PROGRESS }, $or: [{ leaseExpiresAt: { $lt: now } }, { leaseExpiresAt: null }] };
  }
  if (IN_PROGRESS.includes(status)) return { status, leaseExpiresAt: { $gte: now } };
  return { status };
}

function parseDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new ApiError(400, `${field} must be a valid date`);
  return date;
}

function parseIntInRange(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new ApiError(400, `${field} must be a whole number from ${min} to ${max}`);
  return parsed;
}

function truncate(text: unknown, length: number): string | undefined {
  const value = String(text || '');
  if (!value) return undefined;
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function leadName(lead: any): string {
  return [lead?.firstName, lead?.lastName].filter(Boolean).join(' ').trim() || 'Unknown customer';
}

function vehicleLabel(vehicle: any): string | undefined {
  if (!vehicle) return undefined;
  return [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') || undefined;
}

function serializeSummary(draft: any, now: Date, leadsById: Map<string, any>) {
  const lead = draft.leadId ? leadsById.get(String(draft.leadId)) : null;
  return {
    id: String(draft._id),
    channel: draft.channel,
    status: displayStatus(draft, now),
    statusReason: draft.statusReason || undefined,
    kind: draft.kind || undefined,
    lead: draft.leadId ? { id: String(draft.leadId), name: lead ? leadName(lead) : 'Unknown customer' } : null,
    preview: truncate(draft.draftText, PREVIEW_LENGTH),
    handoffReason: draft.handoffReason || undefined,
    classifierVerdict: draft.classifierVerdict || undefined,
    deterministicOk: typeof draft.deterministicOk === 'boolean' ? draft.deterministicOk : undefined,
    coachingVerdict: draft.coachingVerdict || undefined,
    wouldHaveBeenCapped: typeof draft.wouldHaveBeenCapped === 'boolean' ? draft.wouldHaveBeenCapped : undefined,
    aiModel: draft.aiModel || undefined,
    latencyMs: typeof draft.latencyMs === 'number' ? draft.latencyMs : undefined,
    totalTokens: typeof draft.totalTokens === 'number' ? draft.totalTokens : undefined,
    aiCallCount: typeof draft.aiCallCount === 'number' ? draft.aiCallCount : undefined,
    inquiryReceivedAt: draft.inquiryReceivedAt || undefined,
    createdAt: draft.createdAt,
    completedAt: draft.completedAt || undefined,
    expiresAt: draft.expiresAt,
  };
}

async function leadsFor(orgId: string, leadIds: any[]): Promise<Map<string, any>> {
  const ids = Array.from(new Set(leadIds.filter(Boolean).map(String))).filter((id) => mongoose.isValidObjectId(id));
  if (!ids.length) return new Map();
  const rows: any[] = await Lead.find({ _id: { $in: ids }, organizationId: orgId })
    .select('firstName lastName vehicle status source createdAt comments')
    .lean();
  return new Map(rows.map((row) => [String(row._id), row]));
}

function contextEntry(message: any, isSource: boolean) {
  const from = message.direction === 'inbound' ? 'customer' : message.sentBy?.userId === AI_AGENT_ACTOR_ID ? 'ai' : 'staff';
  return {
    from,
    staffName: from === 'staff' ? message.sentBy?.name || undefined : undefined,
    body: truncate(message.body, MAX_BODY) || '',
    at: message.createdAt,
    isSource,
  };
}

async function smsInquiry(orgId: string, draft: any) {
  const orgIds = orgIdVariants(orgId);
  if (!mongoose.isValidObjectId(draft.sourceMessageId) || !draft.conversationId) return { available: false };
  const source: any = await CommunicationMessage.findOne({ _id: draft.sourceMessageId, orgId: { $in: orgIds }, conversationId: draft.conversationId })
    .select('createdAt').lean();
  if (!source) return { available: false };
  const rows: any[] = await CommunicationMessage.find({ conversationId: draft.conversationId, orgId: { $in: orgIds }, createdAt: { $lte: source.createdAt } })
    .sort({ createdAt: -1 })
    .limit(CONTEXT_MESSAGES)
    .select('direction body sentBy createdAt')
    .lean();
  return { available: true, messages: rows.reverse().map((row) => contextEntry(row, String(row._id) === String(draft.sourceMessageId))) };
}

async function webchatInquiry(orgId: string, draft: any) {
  if (!mongoose.isValidObjectId(draft.sourceMessageId) || !draft.sessionId) return { available: false };
  const session = await WebChatSession.findOne({ _id: draft.sessionId, organizationId: orgId }).select('_id').lean();
  if (!session) return { available: false };
  const source: any = await WebChatMessage.findOne({ _id: draft.sourceMessageId, organizationId: orgId, sessionId: draft.sessionId })
    .select('createdAt').lean();
  if (!source) return { available: false };
  const rows: any[] = await WebChatMessage.find({ sessionId: draft.sessionId, organizationId: orgId, aiDispatchPending: { $ne: true }, createdAt: { $lte: source.createdAt } })
    .sort({ createdAt: -1 })
    .limit(CONTEXT_MESSAGES)
    .select('direction body sentBy createdAt')
    .lean();
  return { available: true, messages: rows.reverse().map((row) => contextEntry(row, String(row._id) === String(draft.sourceMessageId))) };
}

function emailInquiry(lead: any) {
  const body = truncate(lead?.comments, MAX_BODY);
  if (!body) return { available: false };
  return { available: true, messages: [{ from: 'customer', body, at: lead.createdAt, isSource: true }] };
}

export const listShadowDrafts = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = viewer(req);
  const now = new Date();
  const query: Record<string, any> = { organizationId: orgId };
  const and: Record<string, any>[] = [];

  const status = req.query.status ? String(req.query.status) : '';
  if (status) {
    if (!(DISPLAY_STATUSES as readonly string[]).includes(status)) throw new ApiError(400, 'Unknown status filter');
    and.push(statusFilter(status as DisplayStatus, now));
  }
  const channel = req.query.channel ? String(req.query.channel) : '';
  if (channel) {
    if (!(AI_DRAFT_CHANNELS as readonly string[]).includes(channel)) throw new ApiError(400, 'Unknown channel filter');
    query.channel = channel;
  }
  const leadId = req.query.leadId ? String(req.query.leadId) : '';
  if (leadId) {
    if (!mongoose.isValidObjectId(leadId)) throw new ApiError(400, 'leadId must be a valid id');
    query.leadId = new mongoose.Types.ObjectId(leadId);
  }
  const from = parseDate(req.query.from, 'from');
  const to = parseDate(req.query.to, 'to');
  if (from && to && from > to) throw new ApiError(400, 'from must be before to');
  if (from || to) query.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (and.length) query.$and = and;

  const sort = req.query.sort ? String(req.query.sort) : 'newest';
  if (!['newest', 'oldest'].includes(sort)) throw new ApiError(400, 'sort must be newest or oldest');
  const page = parseIntInRange(req.query.page, 'page', 1, 1, MAX_PAGE);
  const limit = parseIntInRange(req.query.limit, 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
  const direction = sort === 'oldest' ? 1 : -1;

  const [rows, total] = await Promise.all([
    AiAgentDraft.find(query)
      .sort({ createdAt: direction, _id: direction })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('-leaseId')
      .lean(),
    AiAgentDraft.countDocuments(query),
  ]);
  const leads = await leadsFor(orgId, rows.map((row: any) => row.leadId));
  const drafts = rows.map((row: any) => serializeSummary(row, now, leads));

  res.json(new ApiResponse(200, {
    drafts,
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  }, 'Shadow drafts'));
});

export const getShadowDraft = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = viewer(req);
  const id = String(req.params.id || '');
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Shadow draft not found');
  const draft: any = await AiAgentDraft.findOne({ _id: id, organizationId: orgId }).lean();
  if (!draft) throw new ApiError(404, 'Shadow draft not found');

  const now = new Date();
  const leads = await leadsFor(orgId, [draft.leadId]);
  const lead = draft.leadId ? leads.get(String(draft.leadId)) : null;
  const inquiry = draft.channel === 'sms'
    ? await smsInquiry(orgId, draft)
    : draft.channel === 'webchat'
      ? await webchatInquiry(orgId, draft)
      : lead && String(draft.sourceMessageId) === String(lead._id)
        ? emailInquiry(lead)
        : { available: false };

  res.json(new ApiResponse(200, {
    ...serializeSummary(draft, now, leads),
    draftText: draft.draftText || undefined,
    deterministicReasons: Array.isArray(draft.deterministicReasons) ? draft.deterministicReasons : [],
    coachingRuleIds: Array.isArray(draft.coachingRuleIds) ? draft.coachingRuleIds : [],
    vehicleResolution: draft.vehicleResolution || undefined,
    failureReason: draft.failureReason || undefined,
    modeAtClaim: draft.modeAtClaim || undefined,
    promptTokens: typeof draft.promptTokens === 'number' ? draft.promptTokens : undefined,
    completionTokens: typeof draft.completionTokens === 'number' ? draft.completionTokens : undefined,
    usageDay: draft.usageDay || undefined,
    generationStartedAt: draft.generationStartedAt || undefined,
    lead: lead
      ? { id: String(lead._id), name: leadName(lead), vehicle: vehicleLabel(lead.vehicle), status: lead.status, source: lead.source }
      : draft.leadId ? { id: String(draft.leadId), name: 'Unknown customer' } : null,
    inquiry,
  }, 'Shadow draft'));
});

function recentDayKeys(timezone: string, days: number, now: Date): string[] {
  const keys: string[] = [];
  for (let offset = 0; keys.length < days && offset < (days + 2) * 2; offset++) {
    const key = shadowDraftUsageDay(timezone, new Date(now.getTime() - offset * 12 * 60 * 60 * 1000));
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export const getShadowDraftUsage = asyncHandler(async (req: Request, res: Response) => {
  const { orgId } = viewer(req);
  const days = parseIntInRange(req.query.days, 'days', 7, 1, 30);
  const org: any = await Organization.findById(orgId).select('metadata').lean();
  if (!org) throw new ApiError(404, 'Organization not found');
  const timezone = resolveOrgTimezone(org.metadata);
  const now = new Date();
  const dayKeys = recentDayKeys(timezone, days, now);
  const since = new Date(now.getTime() - (days + 1) * 24 * 60 * 60 * 1000);

  const [counters, grouped] = await Promise.all([
    AiUsageCounter.find({ organizationId: orgId, kind: 'shadow_draft', day: { $in: dayKeys } }).select('day count').lean(),
    AiAgentDraft.aggregate([
      { $match: { organizationId: orgId, createdAt: { $gte: since } } },
      {
        $project: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone } },
          status: {
            $cond: [
              { $and: [{ $in: ['$status', IN_PROGRESS] }, { $or: [{ $lt: ['$leaseExpiresAt', now] }, { $eq: [{ $ifNull: ['$leaseExpiresAt', null] }, null] }] }] },
              'interrupted',
              '$status',
            ],
          },
          latencyMs: 1,
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 1,
        },
      },
      {
        $group: {
          _id: { day: '$day', status: '$status' },
          count: { $sum: 1 },
          latencySum: { $sum: { $ifNull: ['$latencyMs', 0] } },
          latencyCount: { $sum: { $cond: [{ $isNumber: '$latencyMs' }, 1, 0] } },
          promptTokens: { $sum: { $ifNull: ['$promptTokens', 0] } },
          completionTokens: { $sum: { $ifNull: ['$completionTokens', 0] } },
          totalTokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
          tokensReported: { $sum: { $cond: [{ $isNumber: '$totalTokens' }, 1, 0] } },
        },
      },
    ]),
  ]);

  const counterByDay = new Map(counters.map((row: any) => [row.day, row.count || 0]));
  const summary = dayKeys.map((day) => {
    const rows = grouped.filter((row: any) => row._id.day === day);
    const statuses: Record<string, number> = {};
    let latencySum = 0;
    let latencyCount = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let tokensReported = 0;
    for (const row of rows) {
      statuses[row._id.status] = row.count;
      latencySum += row.latencySum;
      latencyCount += row.latencyCount;
      promptTokens += row.promptTokens;
      completionTokens += row.completionTokens;
      totalTokens += row.totalTokens;
      tokensReported += row.tokensReported;
    }
    return {
      day,
      attempts: counterByDay.get(day) || 0,
      drafts: rows.reduce((sum: number, row: any) => sum + row.count, 0),
      statuses,
      averageLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : null,
      tokensReported,
      promptTokens: tokensReported ? promptTokens : null,
      completionTokens: tokensReported ? completionTokens : null,
      totalTokens: tokensReported ? totalTokens : null,
    };
  });

  res.json(new ApiResponse(200, {
    timezone,
    dailyLimit: SHADOW_DRAFT_DAILY_LIMIT,
    today: { day: dayKeys[0], used: counterByDay.get(dayKeys[0]) || 0, limit: SHADOW_DRAFT_DAILY_LIMIT },
    days: summary,
  }, 'Shadow draft usage'));
});
