import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import Organization from '../models/Organization.model';
import AiModeChangeLog from '../models/AiModeChangeLog.model';
import { emitToOrg } from '../utils/socketEmitter';
import logger from '../utils/logger';
import {
  AI_CHANNELS,
  AiChannel,
  AiMode,
  isAiMode,
  isAiMasterSwitchOn,
  modesFromMetadata,
  storedModesFromMetadata,
  anyChannelLive,
  getAiUsageToday,
} from '../services/aiOperatingMode.service';
import {
  isShadowDraftsGloballyEnabled,
  resolveOrgTimezone,
  getShadowDraftUsageToday,
  eligibilityFromMetadata,
  canViewShadowDrafts,
  SHADOW_DRAFT_DAILY_LIMIT,
} from '../services/aiShadowDraft.service';

export const LIVE_CONFIRMATION_PHRASE = 'ENABLE LIVE';
const MIN_LIVE_REASON_LENGTH = 5;

async function buildModesPayload(orgId: string, user: any) {
  const org = await Organization.findById(orgId).select('metadata').lean();
  if (!org) throw new ApiError(404, 'Organization not found');
  const metadata = ((org as any).metadata as any) || {};
  const stored = storedModesFromMetadata(metadata);
  const effective = modesFromMetadata(metadata);
  if (!canViewShadowDrafts(user?.role)) {
    return {
      modes: { sms: stored.sms, email: stored.email, webchat: stored.webchat },
      effective: { sms: effective.sms, email: effective.email, webchat: effective.webchat },
      source: stored.source,
      masterSwitchOn: isAiMasterSwitchOn(),
      configuredAt: null,
      usageToday: {},
      canEdit: false,
      recentChanges: [],
    };
  }
  const timezone = resolveOrgTimezone(metadata);
  const [usageToday, recentChanges, shadowChanges, shadowUsedToday] = await Promise.all([
    getAiUsageToday(orgId),
    AiModeChangeLog.find({ organizationId: orgId, channel: { $in: AI_CHANNELS } }).sort({ createdAt: -1 }).limit(20).lean(),
    AiModeChangeLog.find({ organizationId: orgId, channel: 'shadow_drafts' }).sort({ createdAt: -1 }).limit(10).lean(),
    getShadowDraftUsageToday(orgId, timezone),
  ]);
  const shadowEligibleChannels = AI_CHANNELS.filter((channel) => eligibilityFromMetadata(metadata, channel).eligible);
  return {
    modes: { sms: stored.sms, email: stored.email, webchat: stored.webchat },
    effective: { sms: effective.sms, email: effective.email, webchat: effective.webchat },
    source: stored.source,
    masterSwitchOn: isAiMasterSwitchOn(),
    configuredAt: metadata.aiAgentModesConfiguredAt || null,
    usageToday,
    canEdit: user?.role === 'admin',
    shadowDrafts: {
      globalEnabled: isShadowDraftsGloballyEnabled(),
      orgEnabled: metadata.aiShadowDraftsEnabled === true,
      activeChannels: shadowEligibleChannels,
      usedToday: shadowUsedToday,
      dailyLimit: SHADOW_DRAFT_DAILY_LIMIT,
      timezone,
      recentChanges: (shadowChanges as any[]).map((row) => ({
        id: String(row._id),
        fromMode: row.fromMode,
        toMode: row.toMode,
        reason: row.reason || '',
        changedByName: row.changedByName || '',
        createdAt: row.createdAt,
      })),
    },
    recentChanges: (recentChanges as any[]).map((row) => ({
      id: String(row._id),
      channel: row.channel,
      fromMode: row.fromMode,
      toMode: row.toMode,
      fromSource: row.fromSource,
      reason: row.reason || '',
      changedByName: row.changedByName || '',
      createdAt: row.createdAt,
    })),
  };
}

export const getAiModes = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  res.json(new ApiResponse(200, await buildModesPayload(orgId, user), 'AI operating modes'));
});

const HISTORY_CHANNELS = [...AI_CHANNELS, 'shadow_drafts'] as const;

export const getAiModeHistory = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  if (!canViewShadowDrafts(user.role)) throw new ApiError(403, 'Only managers and admins can view AI change history');

  const channel = req.query.channel ? String(req.query.channel) : '';
  if (channel && !(HISTORY_CHANNELS as readonly string[]).includes(channel)) throw new ApiError(400, 'Unknown channel filter');
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 25);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new ApiError(400, 'page must be a whole number from 1 to 1000');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'limit must be a whole number from 1 to 100');

  const query = { organizationId: orgId, channel: channel ? channel : { $in: HISTORY_CHANNELS } };
  const [rows, total] = await Promise.all([
    AiModeChangeLog.find(query).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AiModeChangeLog.countDocuments(query),
  ]);
  res.json(new ApiResponse(200, {
    changes: (rows as any[]).map((row) => ({
      id: String(row._id),
      channel: row.channel,
      fromMode: row.fromMode,
      toMode: row.toMode,
      fromSource: row.fromSource,
      reason: row.reason || '',
      changedByName: row.changedByName || '',
      createdAt: row.createdAt,
    })),
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  }, 'AI change history'));
});

export const updateShadowDrafts = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can change shadow draft settings');
  if (typeof req.body?.enabled !== 'boolean') throw new ApiError(400, 'enabled must be true or false');

  const enabled = req.body.enabled === true;
  const org = await Organization.findById(orgId).select('metadata').lean();
  if (!org) throw new ApiError(404, 'Organization not found');
  const current = ((org as any).metadata as any)?.aiShadowDraftsEnabled === true;

  if (current !== enabled) {
    await Organization.updateOne({ _id: orgId }, { $set: { 'metadata.aiShadowDraftsEnabled': enabled } });
    await AiModeChangeLog.create({
      organizationId: orgId,
      channel: 'shadow_drafts',
      fromMode: current ? 'on' : 'off',
      toMode: enabled ? 'on' : 'off',
      fromSource: 'configured',
      reason: String(req.body?.reason || '').trim().slice(0, 500) || undefined,
      changedBy: user._id,
      changedByName: user.fullName || user.name || user.email || 'Admin',
    });
    logger.info({ organizationId: orgId, enabled, changedBy: String(user._id) }, '[AiShadowDraft] Organization shadow draft setting changed');
    emitToOrg(orgId, 'ai:modes_updated', { shadowDraftsEnabled: enabled });
  }

  res.json(new ApiResponse(200, await buildModesPayload(orgId, user), current === enabled ? 'No shadow draft changes' : 'Shadow draft setting updated'));
});

export const updateAiModes = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String((req as any).orgId || '');
  const user = (req as any).crmUser;
  if (!orgId || !user) throw new ApiError(401, 'Please authenticate');
  if (user.role !== 'admin') throw new ApiError(403, 'Only admins can change AI operating modes');

  const requested = req.body?.modes;
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new ApiError(400, 'Choose a mode for at least one channel');
  }
  const updates: Partial<Record<AiChannel, AiMode>> = {};
  for (const channel of AI_CHANNELS) {
    if (requested[channel] === undefined) continue;
    if (!isAiMode(requested[channel])) throw new ApiError(400, `Invalid AI mode for ${channel}`);
    updates[channel] = requested[channel];
  }
  if (!Object.keys(updates).length) throw new ApiError(400, 'Choose a mode for at least one channel');

  const org = await Organization.findById(orgId).select('metadata');
  if (!org) throw new ApiError(404, 'Organization not found');
  const metadata: any = (org as any).metadata || {};
  const current = storedModesFromMetadata(metadata);
  const next: Record<AiChannel, AiMode> = {
    sms: updates.sms ?? current.sms,
    email: updates.email ?? current.email,
    webchat: updates.webchat ?? current.webchat,
  };

  const fromLegacy = current.source === 'legacy';
  const changedChannels = AI_CHANNELS.filter((channel) => fromLegacy || next[channel] !== current[channel]);
  if (!changedChannels.length) {
    res.json(new ApiResponse(200, await buildModesPayload(orgId, user), 'No AI mode changes'));
    return;
  }

  const reason = String(req.body?.reason || '').trim().slice(0, 500);
  const goingLive = changedChannels.filter((channel) => next[channel] === 'live' && (fromLegacy || current[channel] !== 'live'));
  if (goingLive.length) {
    if (String(req.body?.confirmLive || '').trim() !== LIVE_CONFIRMATION_PHRASE) {
      throw new ApiError(400, `Type ${LIVE_CONFIRMATION_PHRASE} to confirm turning on live AI replies`);
    }
    if (reason.length < MIN_LIVE_REASON_LENGTH) {
      throw new ApiError(400, 'Add a short reason before turning on live AI replies');
    }
  }

  const now = new Date();
  await Organization.updateOne(
    { _id: orgId },
    {
      $set: {
        'metadata.aiAgentModes': next,
        'metadata.aiAgentModesConfiguredAt': now,
        'metadata.aiAgentModesConfiguredBy': String(user._id),
        'metadata.aiAgentEnabled': anyChannelLive(next),
      },
    },
  );

  await AiModeChangeLog.insertMany(
    changedChannels.map((channel) => ({
      organizationId: orgId,
      channel,
      fromMode: current[channel],
      toMode: next[channel],
      fromSource: current.source,
      reason: reason || undefined,
      changedBy: user._id,
      changedByName: user.fullName || user.name || user.email || 'Admin',
    })),
  );

  logger.info(
    { organizationId: orgId, changedChannels, next, changedBy: String(user._id) },
    '[AiOperatingMode] AI operating modes updated',
  );

  emitToOrg(orgId, 'ai:modes_updated', { modes: next });

  res.json(new ApiResponse(200, await buildModesPayload(orgId, user), 'AI operating modes updated'));
});
