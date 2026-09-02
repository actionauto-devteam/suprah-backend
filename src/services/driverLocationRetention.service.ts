import Load from "../models/Load.model";
import DriverLocation from "../models/DriverLocation.model";
import { GPS_TRACKING_LOAD_STATUSES } from "./driverLocationAccess.service";
import logger from "../utils/logger";

/**
 * Remove the current exact GPS row after the final qualifying tracking
 * relationship ends, unless the driver explicitly opted into Manual GPS.
 *
 * DriverLocation is a current-presence record, not a historical trip log, so
 * deleting it is the smallest privacy-safe retention policy. The next valid
 * heartbeat recreates it automatically.
 */
export async function clearDriverExactLocationIfUnneeded(
  driverId: string,
  reason: string,
) {
  const stillTracked = await Load.exists({
    assignedDriverId: driverId,
    status: { $in: GPS_TRACKING_LOAD_STATUSES },
  });

  if (stillTracked) {
    return { cleared: false, retainedFor: "qualifying_load" as const };
  }

  const result = await DriverLocation.deleteOne({
    userId: driverId,
    manualSharingOptIn: { $ne: true },
  });

  if (result.deletedCount > 0) {
    logger.info(
      { driverId, reason },
      "Cleared exact driver GPS after tracking relationship ended",
    );
    return { cleared: true, retainedFor: null };
  }

  const manualLocation = await DriverLocation.exists({
    userId: driverId,
    manualSharingOptIn: true,
  });

  return {
    cleared: false,
    retainedFor: manualLocation ? ("manual_opt_in" as const) : null,
  };
}

/**
 * Safety-net cleanup for relationship-ending paths outside Driver Tracker
 * (for example a generic staff cancellation). Runs from the existing location
 * monitor and never deletes an explicitly opted-in Manual GPS row.
 */
export async function purgeUnneededDriverExactLocations() {
  const activeDriverIds = (
    await Load.distinct("assignedDriverId", {
      assignedDriverId: { $ne: null },
      status: { $in: GPS_TRACKING_LOAD_STATUSES },
    })
  )
    .map((value: any) => String(value ?? "").trim())
    .filter(Boolean);

  const filter: Record<string, any> = {
    manualSharingOptIn: { $ne: true },
  };
  if (activeDriverIds.length) {
    filter.userId = { $nin: activeDriverIds };
  }

  const result = await DriverLocation.deleteMany(filter);
  if (result.deletedCount > 0) {
    logger.info(
      { deletedCount: result.deletedCount },
      "Purged exact DriverLocation rows with no qualifying tracking relationship",
    );
  }

  return result.deletedCount;
}