import mongoose from 'mongoose';
import TimeLog from '../models/TimeLog.model';
import ActivityInterval from '../models/ActivityInterval.model';
import ScreenshotDeduction from '../models/ScreenshotDeduction.model';
import ExcludedScreenshot from '../models/ExcludedScreenshot.model';
import AuditLog from '../models/AuditLog.model';
import TimeproofArchive, { ITimeproofArchive } from '../models/TimeproofArchive.model';

export interface TimeproofPurgeResult {
  timeLogsDeleted: number;
  activityIntervalsDeleted: number;
  deductionsDeleted: number;
  excludedScreenshotsDeleted: number;
  screenshotsDeleted: number;
}

export async function purgeArchivedTimeproof(
  archived: ITimeproofArchive,
  opts: { reason: string; performedBy?: mongoose.Types.ObjectId | string | null },
): Promise<TimeproofPurgeResult> {
  const userId = archived._id.toString();

  const [timeLogResult, intervalResult, deductionResult, excludedResult] = await Promise.all([
    TimeLog.deleteMany({ userId }),
    ActivityInterval.deleteMany({ userId }),
    ScreenshotDeduction.deleteMany({ userId }),
    ExcludedScreenshot.deleteMany({ userId }),
  ]);

  const { wipeAllScreenshots } = await import('../schedulers/screenshotRetention.scheduler');
  const screenshotResult = await wipeAllScreenshots(new Set([userId]));

  await AuditLog.create({
    entityType: 'TimeLog',
    entityId: userId,
    action: 'DELETE',
    changes: {
      fullName: archived.fullName,
      timeLogsDeleted: timeLogResult.deletedCount,
      activityIntervalsDeleted: intervalResult.deletedCount,
      screenshotsDeleted: screenshotResult.deleted,
    },
    reason: opts.reason,
    performedBy: opts.performedBy ?? undefined,
    organizationId: archived.organizationId?.toString(),
  }).catch(() => {});

  await TimeproofArchive.deleteOne({ _id: archived._id });

  return {
    timeLogsDeleted: timeLogResult.deletedCount,
    activityIntervalsDeleted: intervalResult.deletedCount,
    deductionsDeleted: deductionResult.deletedCount,
    excludedScreenshotsDeleted: excludedResult.deletedCount,
    screenshotsDeleted: screenshotResult.deleted,
  };
}
