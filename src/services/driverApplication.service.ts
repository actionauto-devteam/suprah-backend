import DriverRequest from "../models/DriverRequest.model";

/** MongoDB's duplicate-key error, raised by the one-pending-application rule. */
const isDuplicateKey = (error: unknown) => (error as { code?: number } | null)?.code === 11000;

/**
 * The driver's pending account application, created if there isn't one yet.
 * It's a single database step, so two devices submitting at the same moment
 * get the same application instead of two. The database rule added by
 * scripts/migrate-driver-request-one-pending.ts closes the last tiny gap; a
 * duplicate-key error from it means the other device just created it.
 * `created` says whether this call made it, so admins are notified once.
 */
export async function findOrCreatePendingDriverRequest(
  driverUserId: unknown,
): Promise<{ request: any; created: boolean }> {
  try {
    const result: any = await DriverRequest.findOneAndUpdate(
      { driverUserId, status: "pending" },
      { $setOnInsert: { driverUserId, status: "pending" } },
      { upsert: true, new: true, includeResultMetadata: true },
    );
    return { request: result.value, created: !result.lastErrorObject?.updatedExisting };
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const request = await DriverRequest.findOne({ driverUserId, status: "pending" });
    if (!request) throw error;
    return { request, created: false };
  }
}
