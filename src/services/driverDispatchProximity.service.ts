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
 * Where Dispatch's "miles from pickup" is measured from while they choose a
 * driver for a load (decided 2026-11-05):
 *   1. the location the driver is sharing right now, for any reason (Share
 *      Location / Keep Sharing, or required for a trip), if it was measured
 *      in the last 5 minutes;
 *   2. otherwise, for a driver who isn't on a trip, the delivery address of a
 *      load they delivered in the last 12 hours;
 *   3. otherwise nothing here, and home base is used.
 * A driver who is On Leave or In Shop gets nothing here. Positions never
 * leave the server: Dispatch only ever gets a distance rounded to 5 miles
 * ("under 5 miles" when closer), so a driver's exact location stays private
 * to the dispatcher of the load they accepted. Drivers are told this.
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
    // Any sharing driver; resolveLiveCoordinates below keeps only fresh, shared positions.
    DriverLocation.find({ userId: { $in: objectIds }, isSharing: { $ne: false } })
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

  // On Leave / In Shop: nothing. On a trip: only a location they're sharing now
  // (an earlier delivery isn't where they are any more).
  const notWorking = new Set((notWorkingProfiles as any[]).map((profile) => String(profile.userId)));
  const onTrip = new Set(onTripIds.map((id: unknown) => String(id)));

  for (const location of sharedLocations as any[]) {
    const driverId = String(location.userId);
    if (notWorking.has(driverId)) continue;
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
      if (notWorking.has(driverId) || onTrip.has(driverId) || origins.has(driverId)) return;
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
