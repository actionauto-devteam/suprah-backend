import cron from 'node-cron';
import logger from '../utils/logger';
import DriverProfile, { COMPLIANCE_EXPIRY_FIELDS } from '../models/DriverProfile.model';

/*
 * A CDL, medical card or insurance expires with the passing of time, not when
 * the driver edits their profile, so the stored isComplianceExpired flag (set on
 * save) would otherwise stay "not expired" until the next save. Driver lists,
 * counts and the assign warnings read that flag, so this keeps it current:
 * newly expired profiles are flagged, renewed ones are cleared.
 */
export async function runDriverComplianceExpirySweep(
  nowMs = Date.now(),
): Promise<{ flagged: number; cleared: number }> {
  const now = new Date(nowMs);
  const anyExpired = COMPLIANCE_EXPIRY_FIELDS.map((field) => ({ [field]: { $lt: now } }));

  const flagged = await DriverProfile.updateMany(
    { isComplianceExpired: { $ne: true }, $or: anyExpired },
    { $set: { isComplianceExpired: true } },
  );
  // Renewals saved without the save hook (direct updates) are cleared here too.
  const cleared = await DriverProfile.updateMany(
    { isComplianceExpired: true, $nor: anyExpired },
    { $set: { isComplianceExpired: false } },
  );

  return { flagged: flagged.modifiedCount, cleared: cleared.modifiedCount };
}

async function sweep() {
  try {
    const { flagged, cleared } = await runDriverComplianceExpirySweep();
    if (flagged || cleared) {
      logger.info({ flagged, cleared }, '[DriverComplianceExpiry] Compliance flags updated');
    }
  } catch (error) {
    logger.error({ error }, '[DriverComplianceExpiry] Compliance sweep failed');
  }
}

export const initDriverComplianceExpiryScheduler = () => {
  // Hourly, plus once at startup so a restart never leaves the flag stale.
  cron.schedule('7 * * * *', sweep);
  void sweep();
};
