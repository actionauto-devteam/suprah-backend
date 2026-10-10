import cron from 'node-cron';
import logger from '../utils/logger';
import DriverProfile, {
  COMPLIANCE_EXPIRY_FIELDS,
  CREDENTIAL_DOCUMENT_TYPES,
  approvedCredentialExpiryUpdates,
} from '../models/DriverProfile.model';

/*
 * A CDL, medical card or insurance expires with the passing of time, not when
 * the driver edits their profile, so the stored isComplianceExpired flag (set on
 * save) would otherwise stay "not expired" until the next save. Driver lists,
 * counts and the assign warnings read that flag, so this keeps it current:
 * newly expired profiles are flagged, renewed ones are cleared.
 */

/**
 * Profiles whose approved renewal (a later CDL, medical card or insurance
 * document) was never copied to the stored credential date get that date,
 * so a renewed driver isn't shown as expired. Covers approvals made before
 * approval started copying the date, and any update that bypassed it.
 */
export async function syncApprovedCredentialExpiries(): Promise<number> {
  const profiles = await DriverProfile.find({
    documents: {
      $elemMatch: {
        type: { $in: CREDENTIAL_DOCUMENT_TYPES },
        reviewStatus: 'approved',
        expiresAt: { $ne: null },
      },
    },
  })
    .select(['documents.type', 'documents.expiresAt', 'documents.reviewStatus', ...COMPLIANCE_EXPIRY_FIELDS])
    .lean<Array<{ _id: unknown } & Parameters<typeof approvedCredentialExpiryUpdates>[0]>>();

  const operations = profiles.flatMap((profile) => {
    const updates = approvedCredentialExpiryUpdates(profile);
    return Object.keys(updates).length
      ? [{ updateOne: { filter: { _id: profile._id }, update: { $set: updates } } }]
      : [];
  });
  if (operations.length) await DriverProfile.bulkWrite(operations);
  return operations.length;
}

export async function runDriverComplianceExpirySweep(
  nowMs = Date.now(),
): Promise<{ renewed: number; flagged: number; cleared: number }> {
  // Renewals first, so a renewed driver is cleared in this same run.
  const renewed = await syncApprovedCredentialExpiries();
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

  return { renewed, flagged: flagged.modifiedCount, cleared: cleared.modifiedCount };
}

async function sweep() {
  try {
    const { renewed, flagged, cleared } = await runDriverComplianceExpirySweep();
    if (renewed || flagged || cleared) {
      logger.info({ renewed, flagged, cleared }, '[DriverComplianceExpiry] Compliance flags updated');
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
