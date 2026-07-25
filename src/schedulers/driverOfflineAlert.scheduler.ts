import cron from 'node-cron';
import logger from '../utils/logger';
import DriverLocation from '../models/DriverLocation.model';
import CrmUser from '../models/CrmUser.model';
import User from '../models/User.model';
import notificationService from '../services/notification.service';

/**
 * driverOfflineAlert — flags drivers who are actively on a shipment
 * (shipmentIds non-empty) but have gone silent (no location ping in
 * OFFLINE_THRESHOLD_MS) and haven't already been flagged for this silence
 * gap (offlineAlertSentAt). Notifies each org's admins once per gap; the
 * flag is cleared by driverTracking.controller.ts's updateLocation on the
 * driver's next ping, so a later silence period can alert again.
 */

const OFFLINE_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes of silence

export async function runDriverOfflineAlert(): Promise<{ flagged: number; checked: number }> {
  const cutoff = new Date(Date.now() - OFFLINE_THRESHOLD_MS);

  const stale = await DriverLocation.find({
    status: { $ne: 'offline' },
    lastSeenAt: { $lt: cutoff },
    offlineAlertSentAt: null,
    'shipmentIds.0': { $exists: true },
  })
    .select('userId organizationId lastSeenAt')
    .lean();

  if (stale.length === 0) return { flagged: 0, checked: 0 };

  let flagged = 0;
  for (const loc of stale as any[]) {
    const claimed = await DriverLocation.updateOne(
      { _id: loc._id, offlineAlertSentAt: null },
      { $set: { offlineAlertSentAt: new Date() } },
    );
    if (claimed.modifiedCount === 0) continue;

    const driver = await User.findById(loc.userId).select('name').lean();
    const driverName = driver?.name || 'A driver';
    const title = 'Driver Went Offline';
    const message = `${driverName}'s location tracking has gone silent for over 20 minutes while on an active shipment`;

    const admins = await CrmUser.find({ organizationId: loc.organizationId, role: { $in: ['admin', 'manager'] }, isActive: true })
      .select('_id')
      .lean();

    await Promise.allSettled(
      admins.map((admin) =>
        notificationService.createNotification({
          userId: admin._id.toString(),
          organizationId: loc.organizationId.toString(),
          type: 'driver_tracker_offline_alert',
          title,
          message,
          metadata: { driverId: loc.userId.toString(), route: '/driver-tracker' },
        })
      ),
    );
    flagged++;
  }

  return { flagged, checked: stale.length };
}

export const initDriverOfflineAlertScheduler = () => {
  cron.schedule('*/10 * * * *', async () => {
    try {
      const { flagged } = await runDriverOfflineAlert();
      if (flagged > 0) logger.info(`[driverOfflineAlert] Flagged ${flagged} driver(s) as offline`);
    } catch (error) {
      logger.error({ error }, 'Driver offline alert scheduler error');
    }
  });

  logger.info('✓ Driver offline alert scheduler initialized - Runs every 10 minutes');
};
