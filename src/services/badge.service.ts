import { BADGE_DEFINITIONS } from '../models/Badge.model';
import { UserBadge } from '../models/Badge.model';
import AnalyticsAggregate from '../models/AnalyticsAggregate.model';
import mongoose from 'mongoose';

export async function evaluateBadges(
  organizationId: string,
  userId: string,
  periodType: 'daily' | 'weekly' | 'monthly' | 'alltime',
  periodKey: string
): Promise<string[]> {
  const awarded: string[] = [];

  const query: any = {
    organizationId: new mongoose.Types.ObjectId(organizationId),
    userId:         new mongoose.Types.ObjectId(userId),
  };

  if (periodType !== 'alltime') {
    query.periodType = periodType;
    query.periodKey  = periodKey;
  }

  const agg = await AnalyticsAggregate.findOne(query).lean();
  if (!agg) return [];

  for (const badge of BADGE_DEFINITIONS) {
    const cond = badge.condition;
    const matchesPeriod = cond.period === 'alltime' || cond.period === periodType;
    if (!matchesPeriod) continue;

    const metricValue = cond.metric === 'rank'
      ? agg.rank
      : (agg.kpis as any)[cond.metric];

    if (metricValue === undefined || metricValue === null) continue;

    let earned = false;
    if (cond.operator === 'gte') earned = metricValue >= cond.value;
    if (cond.operator === 'lte') earned = metricValue > 0 && metricValue <= cond.value;
    if (cond.operator === 'eq')  earned = metricValue === cond.value;

    if (earned) {
      try {
        await UserBadge.create({
          organizationId: new mongoose.Types.ObjectId(organizationId),
          userId:         new mongoose.Types.ObjectId(userId),
          badgeId:        badge.id,
          awardedAt:      new Date(),
          periodKey:      cond.period === 'alltime' ? 'alltime' : periodKey,
          metadata:       { metricValue, threshold: cond.value },
        });
        awarded.push(badge.id);
      } catch (err: any) {
        if (err.code !== 11000) console.error('[BADGES] Error awarding badge:', err);
      }
    }
  }

  return awarded;
}

export default { evaluateBadges };