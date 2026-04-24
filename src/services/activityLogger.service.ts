import ActivityLog, { ActivityActionType, SourceModule } from '../models/ActivityLog.model';
import AnalyticsAggregate from '../models/AnalyticsAggregate.model';
import { computeScore, getPeriodKey, getPeriodRange, ACTION_KPI_MAP, DEFAULT_KPI_WEIGHTS } from './kpiEngine.service';
import mongoose from 'mongoose';

interface LogActivityParams {
  organizationId: string;
  userId: string;
  actionType: ActivityActionType;
  sourceModule: SourceModule;
  entityId?: string;
  entityType?: string;
  metadata?: Record<string, any>;
}

/**
 * Central activity logger. Call this from any controller/service to record user actions.
 * Automatically computes score contribution and triggers async aggregate update.
 */
export async function logActivity(params: LogActivityParams): Promise<void> {
  try {
    const kpiMapping = ACTION_KPI_MAP[params.actionType];
    const score = kpiMapping
      ? computeScore({ [kpiMapping.kpi]: kpiMapping.increment })
      : 0;

    await ActivityLog.create({
      organizationId: new mongoose.Types.ObjectId(params.organizationId),
      userId:         new mongoose.Types.ObjectId(params.userId),
      actionType:     params.actionType,
      sourceModule:   params.sourceModule,
      entityId:       params.entityId ? new mongoose.Types.ObjectId(params.entityId) : undefined,
      entityType:     params.entityType,
      metadata:       params.metadata || {},
      score,
      timestamp:      new Date(),
    });

    // Async aggregate update — non-blocking
    updateAggregates(params.organizationId, params.userId, params.actionType, params.metadata)
      .catch(err => console.error('[ANALYTICS] Aggregate update failed:', err));

  } catch (err) {
    // Non-critical — don't break the calling flow
    console.error('[ANALYTICS] logActivity failed:', err);
  }
}

/**
 * Rebuild aggregates for a user for all period types containing the given date.
 * Called after each activity log — runs async.
 */
async function updateAggregates(
  organizationId: string,
  userId: string,
  actionType: string,
  metadata?: Record<string, any>
): Promise<void> {
  const now = new Date();
  const periodTypes: Array<'daily' | 'weekly' | 'monthly'> = ['daily', 'weekly', 'monthly'];

  for (const periodType of periodTypes) {
    const periodKey   = getPeriodKey(now, periodType);
    const { start, end } = getPeriodRange(periodKey, periodType);

    // Aggregate raw logs for this user in this period
    const aggResult = await ActivityLog.aggregate([
      {
        $match: {
          organizationId: new mongoose.Types.ObjectId(organizationId),
          userId:         new mongoose.Types.ObjectId(userId),
          timestamp:      { $gte: start, $lt: end },
        }
      },
      {
        $group: {
          _id: '$actionType',
          count: { $sum: 1 },
          avgMeta: { $avg: '$metadata.responseTimeMin' },
        }
      }
    ]);

    // Build KPI object from aggregated actions
    const counts: Record<string, number> = {};
    let avgResponseTimeMin = 0;
    let responseTimeCount  = 0;

    for (const row of aggResult) {
      const mapping = ACTION_KPI_MAP[row._id];
      if (mapping) {
        counts[mapping.kpi] = (counts[mapping.kpi] || 0) + (row.count * mapping.increment);
      }
      if (row._id === 'lead_replied' && row.avgMeta) {
        avgResponseTimeMin += row.avgMeta * row.count;
        responseTimeCount  += row.count;
      }
    }

    const avgResponse = responseTimeCount > 0 ? avgResponseTimeMin / responseTimeCount : 0;
    const convRate    = counts['leadsCreated'] > 0
      ? Math.round((counts['leadsConverted'] || 0) / counts['leadsCreated'] * 100)
      : 0;
    const showRate    = counts['appointmentsCreated'] > 0
      ? Math.round((counts['appointmentsCompleted'] || 0) / counts['appointmentsCreated'] * 100)
      : 0;

    const kpis = {
      leadsCreated:          counts['leadsCreated']          || 0,
      leadsContacted:        counts['leadsContacted']        || 0,
      leadsConverted:        counts['leadsConverted']        || 0,
      conversionRate:        convRate,
      appointmentsCreated:   counts['appointmentsCreated']   || 0,
      appointmentsCompleted: counts['appointmentsCompleted'] || 0,
      appointmentShowRate:   showRate,
      callsMade:             counts['callsMade']             || 0,
      messagesSent:          counts['messagesSent']          || 0,
      followUpsSent:         counts['followUpsSent']         || 0,
      responsesCount:        counts['leadsContacted']        || 0,
      avgResponseTimeMin:    Math.round(avgResponse * 10) / 10,
      transactionsCompleted: counts['transactionsCompleted'] || 0,
      onboardingsCompleted:  counts['onboardingsCompleted']  || 0,
      totalScore:            0,
    };

    kpis.totalScore = computeScore(kpis, DEFAULT_KPI_WEIGHTS);

    await AnalyticsAggregate.findOneAndUpdate(
      {
        organizationId: new mongoose.Types.ObjectId(organizationId),
        userId:         new mongoose.Types.ObjectId(userId),
        periodType,
        periodKey,
      },
      {
        $set: {
          periodStart: start,
          periodEnd:   end,
          kpis,
        },
      },
      { upsert: true, new: true }
    );
  }
}

/**
 * Rebuild ranks for the entire org for a given period.
 * Called by the ranking cron job or on-demand.
 */
export async function rebuildRanks(
  organizationId: string,
  periodType: 'daily' | 'weekly' | 'monthly',
  periodKey: string
): Promise<void> {
  const docs = await AnalyticsAggregate.find({
    organizationId: new mongoose.Types.ObjectId(organizationId),
    periodType,
    periodKey,
  }).sort({ 'kpis.totalScore': -1 }).lean();

  const bulkOps = docs.map((doc, idx) => ({
    updateOne: {
      filter: { _id: doc._id },
      update: { $set: { prevRank: doc.rank, rank: idx + 1 } },
    },
  }));

  if (bulkOps.length > 0) {
    await AnalyticsAggregate.bulkWrite(bulkOps);
  }
}

export default { logActivity, rebuildRanks };