import { Request, Response as ExpressResponse, NextFunction } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import ActivityLog from '../models/ActivityLog.model';
import AnalyticsAggregate from '../models/AnalyticsAggregate.model';
import { UserBadge, BADGE_DEFINITIONS } from '../models/Badge.model';
import CrmUser from '../models/CrmUser.model';
import { ICrmUser } from '../models/CrmUser.model';
import Organization from '../models/Organization.model';
import { rebuildRanks } from '../services/activityLogger.service';
import { evaluateBadges } from '../services/badge.service';
import { getPeriodKey, getPeriodRange } from '../services/kpiEngine.service';
import {
  leaderboardViewer,
  canViewLeaderboard,
  requireLeaderboardAccess,
  listLeaderboardStaff,
  setLeaderboardAccess,
  LeaderboardViewer,
} from '../services/leaderboardAccess.service';
import {
  resolvePeriod,
  previousPeriod,
  cachedPeriodData,
  buildEntries,
  kpisByPerson,
  teamTotals,
  buildCheckpoints,
  buildTrend,
  buildByAction,
  buildFeed,
  buildRecords,
  awardBadges,
  badgesByKey,
  ResolvedPeriod,
  RANK_METRICS,
  RankMetric,
} from '../services/leaderboardStats.service';
import { COMPANY_TZ, addDaysToDateStr, getCompanyDayRange, toCompanyDateStr } from '../utils/companyTimezone';
import mongoose from 'mongoose';
// @ts-ignore
import { Parser } from 'json2csv';

function requireOrgId(actor: ICrmUser): string {
  const orgId = actor.organizationId?.toString();
  if (!orgId) {
    throw new ApiError(
      403,
      'Your account is not linked to any organization. Contact your administrator.'
    );
  }
  return orgId;
}

function requireCrmUser(req: Request): ICrmUser {
  const actor = req.crmUser;
  if (!actor) throw new ApiError(401, 'Not authenticated');
  return actor;
}

async function viewerOf(req: Request): Promise<LeaderboardViewer> {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);
  return leaderboardViewer(String(actor._id), orgId);
}

function rankMetricOf(value: unknown): RankMetric {
  const metric = String(value || 'calls');
  return (RANK_METRICS as readonly string[]).includes(metric) ? (metric as RankMetric) : 'calls';
}

function periodPayload(period: ResolvedPeriod) {
  return {
    preset: period.preset,
    from: period.fromDate,
    to: period.toDate,
    label: period.label,
    singleDay: period.singleDay,
    start: period.start.toISOString(),
    end: period.end.toISOString(),
    timezone: COMPANY_TZ,
  };
}

export const getAccess = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const viewer = await viewerOf(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json(new ApiResponse(200, { canView: await canViewLeaderboard(viewer), isAdmin: viewer.admin }, 'Leaderboard access'));
});

export const requireAccess = asyncHandler(async (req: Request, _res: ExpressResponse, next: NextFunction) => {
  const viewer = await viewerOf(req);
  await requireLeaderboardAccess(viewer);
  next();
});

export const getAccessStaff = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const viewer = await viewerOf(req);
  if (!viewer.admin) throw new ApiError(403, 'Only admins can see who has Leaderboard access');
  res.setHeader('Cache-Control', 'no-store');
  res.json(new ApiResponse(200, { staff: await listLeaderboardStaff(viewer.orgId) }, 'Leaderboard access list'));
});

export const saveAccess = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const viewer = await viewerOf(req);
  const kind = req.body?.principalKind;
  const principalKind = kind === 'main' || kind === 'crm' ? kind : null;
  if (!principalKind || typeof req.body?.allowed !== 'boolean') {
    throw new ApiError(400, 'Pick a team member and whether they can see the Leaderboard');
  }
  await setLeaderboardAccess({
    admin: viewer,
    principalId: String(req.body?.principalId || ''),
    principalKind,
    allowed: req.body.allowed,
  });
  res.json(new ApiResponse(200, { saved: true }, 'Leaderboard access saved'));
});

export const getLeaderboard = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);
  const period = resolvePeriod(req.query);
  const metric = rankMetricOf(req.query.rankBy);
  const prev = previousPeriod(period);

  await awardBadges(orgId).catch((err) => console.error('[LEADERBOARD] Badge check failed:', err));

  const [data, prevData] = await Promise.all([
    cachedPeriodData(orgId, period.start, period.end),
    cachedPeriodData(orgId, prev.start, prev.end),
  ]);
  const entries = buildEntries(data, metric, prevData);
  const badges = await badgesByKey(orgId, data.people);
  for (const entry of entries) {
    const key = data.people.idToKey.get(entry.user._id);
    entry.badges = (key && badges.get(key)) || [];
  }
  const actorId = String(actor._id);
  const me = entries.find((entry) => entry.user.ids.includes(actorId)) || null;

  res.setHeader('Cache-Control', 'no-store');
  res.json(
    new ApiResponse(200, {
      leaderboard: entries,
      total: entries.length,
      rankBy: metric,
      period: periodPayload(period),
      totals: teamTotals(data, kpisByPerson(data)),
      checkpoints: buildCheckpoints(data, period),
      me,
      updatedAt: new Date().toISOString(),
    }, 'Leaderboard fetched')
  );
});

export const getAnalyticsOverview = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);
  const period = resolvePeriod(req.query);
  const today = toCompanyDateStr(new Date());
  const trendFrom = addDaysToDateStr(today, -29);

  const [data, trendData] = await Promise.all([
    cachedPeriodData(orgId, period.start, period.end),
    cachedPeriodData(orgId, getCompanyDayRange(trendFrom).start, getCompanyDayRange(today).end),
  ]);
  const totals = teamTotals(data, kpisByPerson(data));

  res.setHeader('Cache-Control', 'no-store');
  res.json(
    new ApiResponse(200, {
      totals: {
        activeUsers: totals.activeUsers,
        totalLeadsCreated: totals.leadsCreated,
        totalLeadsConverted: totals.leadsConverted,
        totalAppointments: totals.appointmentsCompleted,
        totalTransactions: totals.transactionsCompleted,
        totalCalls: totals.callsMade,
        totalCallsAll: totals.callsTotal,
        totalCallsAnswered: totals.callsAnswered,
        totalMissedCalls: totals.missedCalls,
        totalTalkTimeSec: totals.talkTimeSec,
        totalMessages: totals.messagesSent,
        totalFollowUps: totals.followUpsSent,
        totalOnboardings: totals.onboardingsCompleted,
        avgConversionRate: totals.conversionRate,
        avgResponseTime: totals.avgResponseTimeMin,
      },
      trend: buildTrend(trendData, trendFrom, 30),
      byAction: buildByAction(data),
      period: periodPayload(period),
    }, 'Analytics overview fetched')
  );
});

export const getActivityFeed = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);
  const period = resolvePeriod(req.query);
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || ''), 10) || 40, 1), 200);
  const data = await cachedPeriodData(orgId, period.start, period.end);

  res.setHeader('Cache-Control', 'no-store');
  res.json(
    new ApiResponse(200, {
      logs: buildFeed(data, limit),
      total: data.events.length,
      page: 1,
      pages: 1,
      period: periodPayload(period),
    }, 'Activity feed fetched')
  );
});

export const getRecords = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);
  const period = resolvePeriod(req.query);
  const scope = req.query.scope === 'full' ? 'full' : 'calls';
  const [data, organization] = await Promise.all([
    cachedPeriodData(orgId, period.start, period.end),
    Organization.findById(orgId).select('name').lean(),
  ]);

  res.setHeader('Cache-Control', 'no-store');
  res.json(new ApiResponse(200, {
    ...buildRecords(data, period, scope, rankMetricOf(req.query.rankBy)),
    organizationName: String((organization as any)?.name || ''),
  }, 'Leaderboard records'));
});


export const getMyStats = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor  = requireCrmUser(req);
  const orgId  = requireOrgId(actor);
  const userId = actor._id.toString();

  const now     = new Date();
  const periods = ['daily', 'weekly', 'monthly'] as const;
  const stats: Record<string, any> = {};

  for (const p of periods) {
    const key = getPeriodKey(now, p);
    const agg = await AnalyticsAggregate.findOne({
      organizationId: new mongoose.Types.ObjectId(orgId),
      userId:         new mongoose.Types.ObjectId(userId),
      periodType:     p,
      periodKey:      key,
    }).lean();
    stats[p] = agg?.kpis || null;
  }

  const recentActivity = await ActivityLog.find({
    organizationId: new mongoose.Types.ObjectId(orgId),
    userId:         new mongoose.Types.ObjectId(userId),
  })
    .sort({ timestamp: -1 })
    .limit(20)
    .lean();

  const myBadges = await UserBadge.find({
    organizationId: new mongoose.Types.ObjectId(orgId),
    userId:         new mongoose.Types.ObjectId(userId),
  })
    .sort({ awardedAt: -1 })
    .lean();

  const enrichedBadges = myBadges.map(b => ({
    ...b,
    definition: BADGE_DEFINITIONS.find(d => d.id === b.badgeId),
  }));

  res.json(
    new ApiResponse(200, { stats, recentActivity, badges: enrichedBadges }, 'Personal stats fetched')
  );
});


export const getUserStats = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);

  if (actor.role === 'employee') {
    throw new ApiError(403, 'Access denied. Managers and admins only.');
  }

  const { userId }   = req.params;
  const periodType   = (req.query.periodType as string) || 'monthly';
  const periodKey    = (req.query.periodKey  as string) || getPeriodKey(new Date(), periodType as any);

  const user = await CrmUser.findOne({
    _id:            userId,
    organizationId: new mongoose.Types.ObjectId(orgId),
  })
    .select('fullName username email avatar role isActive lastLoginAt createdAt')
    .lean();

  if (!user) throw new ApiError(404, 'User not found in your organization');

  const [aggregate, badges, recentActivity] = await Promise.all([
    AnalyticsAggregate.findOne({
      organizationId: new mongoose.Types.ObjectId(orgId),
      userId:         new mongoose.Types.ObjectId(userId),
      periodType,
      periodKey,
    }).lean(),

    UserBadge.find({
      organizationId: new mongoose.Types.ObjectId(orgId),
      userId:         new mongoose.Types.ObjectId(userId),
    })
      .sort({ awardedAt: -1 })
      .lean(),

    ActivityLog.find({
      organizationId: new mongoose.Types.ObjectId(orgId),
      userId:         new mongoose.Types.ObjectId(userId),
    })
      .sort({ timestamp: -1 })
      .limit(30)
      .lean(),
  ]);

  const enrichedBadges = badges.map(b => ({
    ...b,
    definition: BADGE_DEFINITIONS.find(d => d.id === b.badgeId),
  }));

  res.json(
    new ApiResponse(200, {
      user,
      kpis:           aggregate?.kpis || null,
      rank:           aggregate?.rank,
      prevRank:       aggregate?.prevRank,
      badges:         enrichedBadges,
      recentActivity,
    }, 'User stats fetched')
  );
});


export const exportAnalytics = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);

  if (actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can export analytics data');
  }

  const exportType = (req.query.type       as string) || 'leaderboard';
  const periodType = (req.query.periodType as string) || 'monthly';

  if (!['leaderboard', 'activity'].includes(exportType)) {
    throw new ApiError(400, 'type must be leaderboard or activity');
  }

  if (!['daily', 'weekly', 'monthly'].includes(periodType)) {
    throw new ApiError(400, 'periodType must be daily, weekly, or monthly');
  }

  const periodKey  = (req.query.periodKey  as string) || getPeriodKey(new Date(), periodType as any);

  let rows: any[] = [];

  if (exportType === 'leaderboard') {
    await rebuildRanks(orgId, periodType as any, periodKey);

    const docs = await AnalyticsAggregate.find({
      organizationId: new mongoose.Types.ObjectId(orgId),
      periodType,
      periodKey,
    })
      .sort({ rank: 1 })
      .lean();

    const userIds = docs.map(d => d.userId.toString());
    const users   = await CrmUser.find({
      _id:            { $in: userIds },
      organizationId: new mongoose.Types.ObjectId(orgId),
    })
      .select('fullName username email role')
      .lean();

    const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

    rows = docs.map(d => ({
      rank:                  d.rank,
      fullName:              userMap[d.userId.toString()]?.fullName,
      username:              userMap[d.userId.toString()]?.username,
      email:                 userMap[d.userId.toString()]?.email,
      role:                  userMap[d.userId.toString()]?.role,
      totalScore:            d.kpis.totalScore,
      leadsCreated:          d.kpis.leadsCreated,
      leadsConverted:        d.kpis.leadsConverted,
      conversionRate:        d.kpis.conversionRate,
      appointmentsCompleted: d.kpis.appointmentsCompleted,
      callsMade:             d.kpis.callsMade,
      messagesSent:          d.kpis.messagesSent,
      followUpsSent:         d.kpis.followUpsSent,
      transactionsCompleted: d.kpis.transactionsCompleted,
      onboardingsCompleted:  d.kpis.onboardingsCompleted,
      avgResponseTimeMin:    d.kpis.avgResponseTimeMin,
      period:                periodKey,
    }));
  } else {
    const { start, end } = getPeriodRange(periodKey, periodType as any);
    const logs = await ActivityLog.find({
      organizationId: new mongoose.Types.ObjectId(orgId),
      timestamp:      { $gte: start, $lt: end },
    })
      .sort({ timestamp: -1 })
      .lean();

    const userIds = [...new Set(logs.map(l => l.userId.toString()))];
    const users   = await CrmUser.find({
      _id:            { $in: userIds },
      organizationId: new mongoose.Types.ObjectId(orgId),
    })
      .select('fullName username')
      .lean();

    const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

    rows = logs.map(l => ({
      timestamp:    l.timestamp.toISOString(),
      fullName:     userMap[l.userId.toString()]?.fullName,
      username:     userMap[l.userId.toString()]?.username,
      actionType:   l.actionType,
      sourceModule: l.sourceModule,
      entityType:   l.entityType,
      score:        l.score,
    }));
  }

  const fields = exportType === 'leaderboard'
    ? ['rank', 'fullName', 'username', 'email', 'role', 'totalScore', 'leadsCreated', 'leadsConverted', 'conversionRate', 'appointmentsCompleted', 'callsMade', 'messagesSent', 'followUpsSent', 'transactionsCompleted', 'onboardingsCompleted', 'avgResponseTimeMin', 'period']
    : ['timestamp', 'fullName', 'username', 'actionType', 'sourceModule', 'entityType', 'score'];
  const parser = new Parser({ fields });
  const csv    = parser.parse(rows);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="analytics_${exportType}_${periodKey}.csv"`
  );
  res.send(csv);
});


export const triggerBadgeEvaluation = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);

  if (actor.role !== 'admin') {
    throw new ApiError(403, 'Only admins can trigger badge evaluation');
  }

  const userId = req.body.userId || actor._id.toString();
  const period = (req.body.periodType as 'daily' | 'weekly' | 'monthly') || 'weekly';
  const key    = req.body.periodKey || getPeriodKey(new Date(), period);

  if (req.body.userId) {
    const targetUser = await CrmUser.findOne({
      _id:            req.body.userId,
      organizationId: new mongoose.Types.ObjectId(orgId),
    });
    if (!targetUser) throw new ApiError(404, 'User not found in your organization');
  }

  const awarded = await evaluateBadges(orgId, userId, period, key);

  res.json(
    new ApiResponse(200, { awarded, count: awarded.length }, `${awarded.length} badge(s) awarded`)
  );
});

export default {
  getAccess,
  requireAccess,
  getAccessStaff,
  saveAccess,
  getLeaderboard,
  getMyStats,
  getAnalyticsOverview,
  getActivityFeed,
  getRecords,
  getUserStats,
  exportAnalytics,
  triggerBadgeEvaluation,
};
