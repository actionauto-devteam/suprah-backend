import { Request, Response as ExpressResponse } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import ActivityLog from '../models/ActivityLog.model';
import AnalyticsAggregate from '../models/AnalyticsAggregate.model';
import { UserBadge, BADGE_DEFINITIONS } from '../models/Badge.model';
import CrmUser from '../models/CrmUser.model';
import { ICrmUser } from '../models/CrmUser.model';
import { rebuildRanks } from '../services/activityLogger.service';
import { evaluateBadges } from '../services/badge.service';
import { getPeriodKey, getPeriodRange } from '../services/kpiEngine.service';
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


export const getLeaderboard = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor      = requireCrmUser(req);
  const orgId      = requireOrgId(actor);
  const periodType = (req.query.periodType as string) || 'weekly';
  const periodKey  = (req.query.periodKey  as string) || getPeriodKey(new Date(), periodType as any);
  const limit      = Math.min(parseInt(req.query.limit as string) || 20, 100);

  if (!['daily', 'weekly', 'monthly'].includes(periodType)) {
    throw new ApiError(400, 'periodType must be daily, weekly, or monthly');
  }

  if (actor.role === 'admin') {
    await rebuildRanks(orgId, periodType as any, periodKey);
  }

  const query: any = {
    organizationId: new mongoose.Types.ObjectId(orgId),
    periodType,
    periodKey,
  };

  if (actor.role === 'employee') {
    query.userId = actor._id;
  }

  const docs = await AnalyticsAggregate.find(query)
    .sort({ rank: 1, 'kpis.totalScore': -1 })
    .limit(limit)
    .lean();

  const userIds = [...new Set(docs.map(d => d.userId.toString()))];
  const users   = await CrmUser.find({
    _id:            { $in: userIds },
    organizationId: new mongoose.Types.ObjectId(orgId),
  })
    .select('fullName username avatar role')
    .lean();

  const userMap = Object.fromEntries(users.map(u => [u._id.toString(), u]));

  const badges = await UserBadge.find({
    organizationId: new mongoose.Types.ObjectId(orgId),
    userId:         { $in: userIds.map(id => new mongoose.Types.ObjectId(id)) },
  }).lean();

  const badgeMap: Record<string, string[]> = {};
  for (const b of badges) {
    const key = b.userId.toString();
    if (!badgeMap[key]) badgeMap[key] = [];
    badgeMap[key].push(b.badgeId);
  }

  const leaderboard = docs.map((doc, idx) => ({
    rank:       doc.rank || idx + 1,
    prevRank:   doc.prevRank,
    rankChange: doc.prevRank ? doc.prevRank - (doc.rank || idx + 1) : null,
    user:       userMap[doc.userId.toString()] || { fullName: 'Unknown', username: '-' },
    kpis:       doc.kpis,
    badges:     badgeMap[doc.userId.toString()] || [],
    periodKey,
    periodType,
  }));

  res.json(
    new ApiResponse(200, { leaderboard, total: leaderboard.length, periodKey, periodType }, 'Leaderboard fetched')
  );
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


export const getAnalyticsOverview = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);

  if (actor.role === 'employee') {
    throw new ApiError(403, 'Access denied. Managers and admins only.');
  }

  const periodType = (req.query.periodType as string) || 'weekly';
  const periodKey  = (req.query.periodKey  as string) || getPeriodKey(new Date(), periodType as any);
  const { start, end } = getPeriodRange(periodKey, periodType as any);

  const orgTotals = await AnalyticsAggregate.aggregate([
    {
      $match: {
        organizationId: new mongoose.Types.ObjectId(orgId),
        periodType,
        periodKey,
      },
    },
    {
      $group: {
        _id:                   null,
        totalLeadsCreated:     { $sum: '$kpis.leadsCreated' },
        totalLeadsConverted:   { $sum: '$kpis.leadsConverted' },
        totalAppointments:     { $sum: '$kpis.appointmentsCompleted' },
        totalCalls:            { $sum: '$kpis.callsMade' },
        totalMessages:         { $sum: '$kpis.messagesSent' },
        totalFollowUps:        { $sum: '$kpis.followUpsSent' },
        totalTransactions:     { $sum: '$kpis.transactionsCompleted' },
        totalOnboardings:      { $sum: '$kpis.onboardingsCompleted' },
        avgConversionRate:     { $avg: '$kpis.conversionRate' },
        avgResponseTime:       { $avg: '$kpis.avgResponseTimeMin' },
        activeUsers:           { $sum: 1 },
      },
    },
  ]);

  const trendStart = new Date();
  trendStart.setDate(trendStart.getDate() - 30);

  const trend = await ActivityLog.aggregate([
    {
      $match: {
        organizationId: new mongoose.Types.ObjectId(orgId),
        timestamp:      { $gte: trendStart },
      },
    },
    {
      $group: {
        _id:   { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
        count: { $sum: 1 },
        score: { $sum: '$score' },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const byAction = await ActivityLog.aggregate([
    {
      $match: {
        organizationId: new mongoose.Types.ObjectId(orgId),
        timestamp:      { $gte: start, $lt: end },
      },
    },
    {
      $group: {
        _id:   '$actionType',
        count: { $sum: 1 },
        score: { $sum: '$score' },
      },
    },
    { $sort: { count: -1 } },
  ]);

  res.json(
    new ApiResponse(200, {
      totals:  orgTotals[0] || {},
      trend,
      byAction,
      period:  { type: periodType, key: periodKey, start, end },
    }, 'Analytics overview fetched')
  );
});


export const getActivityFeed = asyncHandler(async (req: Request, res: ExpressResponse) => {
  const actor = requireCrmUser(req);
  const orgId = requireOrgId(actor);

  const page  = parseInt(req.query.page  as string) || 1;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
  const skip  = (page - 1) * limit;

  const filter: any = {
    organizationId: new mongoose.Types.ObjectId(orgId),
  };

  if (actor.role === 'employee') {
    filter.userId = actor._id;
  } else if (req.query.userId) {
    filter.userId = new mongoose.Types.ObjectId(req.query.userId as string);
  }

  if (req.query.actionType) filter.actionType = req.query.actionType;

  if (req.query.startDate) {
    filter.timestamp = { $gte: new Date(req.query.startDate as string) };
  }
  if (req.query.endDate) {
    filter.timestamp = {
      ...filter.timestamp,
      $lte: new Date(req.query.endDate as string),
    };
  }

  const [logs, total] = await Promise.all([
    ActivityLog.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    ActivityLog.countDocuments(filter),
  ]);

  const userIds = [...new Set(logs.map(l => l.userId.toString()))];
  const users   = await CrmUser.find({
    _id:            { $in: userIds },
    organizationId: new mongoose.Types.ObjectId(orgId),
  })
    .select('fullName username avatar')
    .lean();

  const userMap  = Object.fromEntries(users.map(u => [u._id.toString(), u]));
  const enriched = logs.map(l => ({ ...l, user: userMap[l.userId.toString()] }));

  res.json(
    new ApiResponse(200, {
      logs:  enriched,
      total,
      page,
      pages: Math.ceil(total / limit),
    }, 'Activity feed fetched')
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
  const periodKey  = (req.query.periodKey  as string) || getPeriodKey(new Date(), periodType as any);

  let rows: any[] = [];

  if (exportType === 'leaderboard') {
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

  if (rows.length === 0) {
    throw new ApiError(404, 'No data found for the selected period');
  }

  const parser = new Parser({ fields: Object.keys(rows[0]) });
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
  getLeaderboard,
  getMyStats,
  getAnalyticsOverview,
  getActivityFeed,
  getUserStats,
  exportAnalytics,
  triggerBadgeEvaluation,
};