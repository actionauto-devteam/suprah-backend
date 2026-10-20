import mongoose from "mongoose";
import Load from "../models/Load.model";
import DriverLocation from "../models/DriverLocation.model";
import DriverProfile from "../models/DriverProfile.model";
import { GPS_TRACKING_LOAD_STATUSES } from "../constants/loadStatus";
import { getCoordinatesFromZip } from "../utils/calculations";
import logger from "../utils/logger";
import {
  coordinatesFromUnknown,
  resolveLiveCoordinates,
  type CoordinatePair,
  type DispatchProximityOrigin,
} from "./driverRouteMatching.service";

/**
 * Where Dispatch's "miles from pickup" is measured from before a load is
 * assigned, for a driver who isn't on a trip:
 *   1. the location the driver chose to share (Share Location / Keep
 *      Sharing), if it was measured in the last 5 minutes;
 *   2. otherwise the delivery address of a load they delivered in the last
 *      12 hours;
 *   3. otherwise nothing here, and home base is used.
 * A driver with an accepted, picked-up or in-transit load gets nothing here:
 * they are on a trip, and their live location stays private to that load's
 * dispatcher. Neither does a driver who is On Leave or In Shop. Positions
 * never leave the server; only a rounded distance does.
 */
export const LAST_DELIVERY_WINDOW_MS = 12 * 60 * 60 * 1000;

async function deliveryCoordinates(location: any): Promise<CoordinatePair | null> {
  const pinned = coordinatesFromUnknown(location?.coordinates);
  if (pinned) return pinned;
  const zip = String(location?.zip ?? "").trim();
  if (!/^\d{5}(?:-\d{4})?$/.test(zip)) return null;
  try {
    const byZip = await getCoordinatesFromZip(zip.slice(0, 5));
    return byZip ? { lat: byZip.lat, lon: byZip.lon } : null;
  } catch (error) {
    logger.warn({ error }, "Non-fatal: could not place a last delivery for pickup distance");
    return null;
  }
}

export async function getDispatchProximityOrigins(
  driverIds: string[],
  now: Date = new Date(),
): Promise<Map<string, DispatchProximityOrigin>> {
  const origins = new Map<string, DispatchProximityOrigin>();
  const ids = [...new Set(driverIds.map(String))].filter((id) =>
    mongoose.Types.ObjectId.isValid(id),
  );
  if (ids.length === 0) return origins;
  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const deliveredSince = new Date(now.getTime() - LAST_DELIVERY_WINDOW_MS);

  const [onTripIds, notWorkingProfiles, sharedLocations, lastDeliveries] = await Promise.all([
    Load.distinct("assignedDriverId", {
      assignedDriverId: { $in: objectIds },
      status: { $in: GPS_TRACKING_LOAD_STATUSES },
    }),
    DriverProfile.find({
      userId: { $in: objectIds },
      operationalStatus: { $in: ["on_leave", "maintenance"] },
    })
      .select("userId")
      .lean(),
    DriverLocation.find({ userId: { $in: objectIds }, manualSharingOptIn: true })
      .select("userId coords isSharing lastSeenAt locationRecordedAt")
      .lean(),
    Load.aggregate([
      {
        $match: {
          assignedDriverId: { $in: objectIds },
          status: "Delivered",
          deliveredAt: { $gte: deliveredSince, $lte: now },
        },
      },
      { $sort: { deliveredAt: -1 } },
      {
        $group: {
          _id: "$assignedDriverId",
          deliveredAt: { $first: "$deliveredAt" },
          deliveryLocation: { $first: "$deliveryLocation" },
        },
      },
    ]),
  ]);

  // Skipped: on a trip, or On Leave / In Shop.
  const onTrip = new Set([
    ...onTripIds.map((id: unknown) => String(id)),
    ...(notWorkingProfiles as any[]).map((profile) => String(profile.userId)),
  ]);

  for (const location of sharedLocations as any[]) {
    const driverId = String(location.userId);
    if (onTrip.has(driverId)) continue;
    const live = resolveLiveCoordinates(location);
    if (live.coords && live.lastSeenAt) {
      origins.set(driverId, {
        coords: live.coords,
        source: "shared_location",
        at: new Date(live.lastSeenAt),
      });
    }
  }

  await Promise.all(
    (lastDeliveries as any[]).map(async (delivery) => {
      const driverId = String(delivery._id);
      if (onTrip.has(driverId) || origins.has(driverId)) return;
      const coords = await deliveryCoordinates(delivery.deliveryLocation);
      if (coords) {
        origins.set(driverId, {
          coords,
          source: "last_delivery",
          at: new Date(delivery.deliveredAt),
        });
      }
    }),
  );

  return origins;
}
