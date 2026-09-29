import cron from 'node-cron';
import Vehicle from '../models/Vehicle.model';
import VehicleReengagementLog from '../models/VehicleReengagementLog.model';
import { processVehicleForReengagement } from '../services/vehicleReengagement.service';
import { notifyOrgAdmins } from '../utils/safeNotification';
import { isWithinSendingHours } from '../utils/sendingWindow';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.VEHICLE_REENGAGEMENT_CRON || '*/30 * * * *';
const BATCH_LIMIT_VEHICLES = parseInt(process.env.VEHICLE_REENGAGEMENT_BATCH_LIMIT_VEHICLES || '10', 10);

interface ReengagementSweepStats {
  vehiclesScanned: number;
  vehiclesProcessed: number;
  leadsMatched: number;
  errors: number;
}

export async function runVehicleReengagementSweep(): Promise<ReengagementSweepStats> {
  const stats: ReengagementSweepStats = { vehiclesScanned: 0, vehiclesProcessed: 0, leadsMatched: 0, errors: 0 };
  const now = new Date();
  if (!isWithinSendingHours(now)) return stats;

  const candidates = await Vehicle.find({
    status: 'Ready for Sale',
    isArchived: false,
    isDeleted: false,
    $or: [
      { reengagementSweptAt: null },
      { reengagementSweptAt: { $exists: false } },
    ],
  })
    .limit(BATCH_LIMIT_VEHICLES)
    .lean();

  stats.vehiclesScanned = candidates.length;

  const blockedOrgIds = new Set<string>();

  for (const vehicleDoc of candidates as any[]) {
    try {
      const claimed = await Vehicle.findOneAndUpdate(
        {
          _id: vehicleDoc._id,
          $or: [
            { reengagementSweptAt: null },
            { reengagementSweptAt: { $exists: false } },
          ],
        },
        { $set: { reengagementSweptAt: now } },
        { new: true, timestamps: false },
      );
      if (!claimed) continue;

      const result = await processVehicleForReengagement(claimed);
      stats.vehiclesProcessed++;
      stats.leadsMatched += result.matched;

      if (result.matched > 0) {
        const hasBlocked = await VehicleReengagementLog.exists({
          vehicleId: claimed._id,
          status: 'blocked',
        });
        if (hasBlocked) blockedOrgIds.add(String(claimed.organizationId));
      }
    } catch (err) {
      stats.errors++;
      logger.error({ err, vehicleId: vehicleDoc._id }, '[VehicleReengagement] Failed to process vehicle');
    }
  }

  for (const orgId of blockedOrgIds) {
    await notifyOrgAdmins(
      orgId,
      'vehicle_reengagement_blocked',
      'Re-engagement messages need review',
      'Some AI-generated re-engagement texts were blocked by the safety check and are waiting for review.',
      { route: '/crm/vehicle-reengagement' },
      undefined,
      { dedupeKeyPrefix: 'vehicle-reengagement-blocked', groupWindowMinutes: 60 },
    ).catch(() => undefined);
  }

  return stats;
}

export function initVehicleReengagementScheduler(): void {
  if (process.env.VEHICLE_REENGAGEMENT_ENABLED !== 'true') {
    logger.info('[VehicleReengagement] Disabled. Set VEHICLE_REENGAGEMENT_ENABLED=true to enable');
    return;
  }

  runVehicleReengagementSweep().catch((err) => logger.error(err, '[VehicleReengagement] Startup sweep failed'));

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runVehicleReengagementSweep();
      if (stats.vehiclesProcessed > 0 || stats.errors > 0) {
        logger.info(stats, '[VehicleReengagement] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[VehicleReengagement] Sweep failed');
    }
  });

  logger.info(`[VehicleReengagement] Initialized. Schedule: ${CRON_SCHEDULE}`);
}
