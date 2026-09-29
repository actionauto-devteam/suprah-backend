import cron from 'node-cron';
import Vehicle from '../models/Vehicle.model';
import { processVehicleForPriceDrop } from '../services/priceDropEmail.service';
import { isWithinSendingHours } from '../utils/sendingWindow';
import logger from '../utils/logger';

const CRON_SCHEDULE = process.env.PRICE_DROP_EMAIL_CRON || '*/30 * * * *';
const BATCH_LIMIT_VEHICLES = parseInt(process.env.PRICE_DROP_EMAIL_BATCH_LIMIT_VEHICLES || '10', 10);

const NEEDS_SWEEP_CONDITION = {
  $or: [
    { lastPriceDropEmailSweptAt: null },
    { lastPriceDropEmailSweptAt: { $exists: false } },
    { $expr: { $gt: ['$priceUpdatedAt', '$lastPriceDropEmailSweptAt'] } },
  ],
};

interface PriceDropSweepStats {
  vehiclesScanned: number;
  vehiclesProcessed: number;
  leadsMatched: number;
  errors: number;
}

export async function runPriceDropEmailSweep(): Promise<PriceDropSweepStats> {
  const stats: PriceDropSweepStats = { vehiclesScanned: 0, vehiclesProcessed: 0, leadsMatched: 0, errors: 0 };
  const now = new Date();
  if (!isWithinSendingHours(now)) return stats;

  const candidates = await Vehicle.find({
    isArchived: false,
    isDeleted: false,
    priceUpdatedAt: { $exists: true, $ne: null },
    ...NEEDS_SWEEP_CONDITION,
  })
    .limit(BATCH_LIMIT_VEHICLES)
    .lean();

  stats.vehiclesScanned = candidates.length;

  for (const vehicleDoc of candidates as any[]) {
    try {
      const claimed = await Vehicle.findOneAndUpdate(
        { _id: vehicleDoc._id, ...NEEDS_SWEEP_CONDITION },
        { $set: { lastPriceDropEmailSweptAt: now } },
        { new: true, timestamps: false },
      );
      if (!claimed) continue;

      const result = await processVehicleForPriceDrop(claimed);
      stats.vehiclesProcessed++;
      stats.leadsMatched += result.matched;
    } catch (err) {
      stats.errors++;
      logger.error({ err, vehicleId: vehicleDoc._id }, '[PriceDropEmail] Failed to process vehicle');
    }
  }

  return stats;
}

export function initPriceDropEmailScheduler(): void {
  if (process.env.PRICE_DROP_EMAIL_ENABLED !== 'true') {
    logger.info('[PriceDropEmail] Disabled. Set PRICE_DROP_EMAIL_ENABLED=true to enable');
    return;
  }

  runPriceDropEmailSweep().catch((err) => logger.error(err, '[PriceDropEmail] Startup sweep failed'));

  cron.schedule(CRON_SCHEDULE, async () => {
    try {
      const stats = await runPriceDropEmailSweep();
      if (stats.vehiclesProcessed > 0 || stats.errors > 0) {
        logger.info(stats, '[PriceDropEmail] Sweep complete');
      }
    } catch (err) {
      logger.error(err, '[PriceDropEmail] Sweep failed');
    }
  });

  logger.info(`[PriceDropEmail] Initialized. Schedule: ${CRON_SCHEDULE}`);
}
