import Load from "../models/Load.model";
import Notification from "../models/Notification.model";
import User from "../models/User.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverLocation from "../models/DriverLocation.model";
import logger from "../utils/logger";
import { getCoordinatesFromZip } from "../utils/calculations";
import { safeCreateNotification } from "../utils/safeNotification";
import { emitToUser } from "../utils/socketEmitter";
import { isOrganizationActive } from "./activeOrganizations.service";
import {
  DriverLoadCompatibility,
  evaluateDriverLoadCompatibility,
  evaluateDriverLoadCompatibilityWithRecommendations,
} from "./driverLoadCompatibility.service";
import { getDriverWorkEligibility } from "./driverStatusTransition.service";
import { findDriverCommitmentConflicts } from "./driverWorkCommitment.service";

/**
 * Tells drivers when a load appears on the shared Available Loads board and
 * they could request it right now.
 *
 * - Nothing to check: "New Load You Can Request".
 * - Requestable, but something differs from the driver's setup (pickup day,
 *   trailer type, service area or preferred routes, the same mismatches the
 *   board's load cards flag): "New Load: Check Before Requesting", naming each one.
 * - Drivers who couldn't request it (not approved, On Leave or In Shop, busy at
 *   that time, or a trailer that can't carry the vehicles) aren't told.
 *
 * Each load is announced once: when it's created on the board, or when a
 * private load that is still waiting for a driver is made public.
 */

export const NEW_LOAD_FITS_TYPE = "new_load_available" as const;
export const NEW_LOAD_CHECK_FIRST_TYPE = "new_load_check_first" as const;
/** What an alert becomes once its load has left the board. */
export const NEW_LOAD_UNAVAILABLE_TYPE = "new_load_unavailable" as const;

export type NewLoadCheckReason =
  | "off_schedule"
  | "trailer_mismatch"
  | "outside_service_area"
  | "not_preferred_route";

// Same labels as the Equipment page's trailer list.
const TRAILER_LABELS: Record<string, string> = {
  open_3car_wedge: "Open 3-Car Wedge",
  open_2car: "Open 2-Car",
  "5car_open": "5-Car Open",
  enclosed_2car: "Enclosed 2-Car",
  enclosed_3car: "Enclosed 3-Car",
  flatbed: "Flatbed",
  dually_flatbed: "Dually Flatbed",
  hotshot: "Hotshot",
  gooseneck: "Gooseneck",
  lowboy: "Lowboy",
  step_deck: "Step Deck",
  rgn: "RGN",
  double_drop: "Double Drop",
  "9car_stinger": "9-Car Stinger",
  "7car_stinger": "7-Car Stinger",
  power_only: "Power Only",
  other: "Other",
};

const trailerLabel = (value: string | null) =>
  value ? TRAILER_LABELS[value] ?? value.replace(/_/g, " ") : "";

const withArticle = (label: string) =>
  `${/^([aeiou]|rgn)/i.test(label) ? "an" : "a"} ${label}`;

const titleDay = (day: string | null) =>
  day ? day[0].toUpperCase() + day.slice(1) : "";

function place(location: any): string {
  return [location?.city, location?.state]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

// Load dates come from date pickers and are stored as UTC midnight, so the
// calendar date is read in UTC (the same day the dispatcher picked).
function pickupDateLabel(load: any): string {
  const raw = load?.dates?.firstAvailable ?? load?.dates?.pickupDeadline;
  if (!raw) return "";
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function newLoadCheckReasons(compatibility: DriverLoadCompatibility): NewLoadCheckReason[] {
  const reasons: NewLoadCheckReason[] = [];
  if (compatibility.availability.status === "off_schedule") reasons.push("off_schedule");
  if (compatibility.trailer.status === "mismatch") reasons.push("trailer_mismatch");
  if (compatibility.serviceArea?.status === "outside") reasons.push("outside_service_area");
  if (compatibility.preferredRoute?.status === "not_preferred") reasons.push("not_preferred_route");
  return reasons;
}

function reasonText(reason: NewLoadCheckReason, compatibility: DriverLoadCompatibility): string {
  switch (reason) {
    case "off_schedule": {
      const day = titleDay(compatibility.availability.pickupDay);
      return day
        ? `the pickup is on ${day}, which isn't one of your work days`
        : "the pickup isn't on one of your work days";
    }
    case "trailer_mismatch":
      return `it asks for ${withArticle(trailerLabel(compatibility.trailer.requiredTrailerType))} trailer, and yours is ${withArticle(trailerLabel(compatibility.trailer.driverTrailerType))}`;
    case "outside_service_area": {
      const miles = compatibility.serviceArea.distanceFromHomeBaseToPickupMiles;
      const radius = compatibility.serviceArea.serviceRadiusMiles;
      return miles != null && radius != null
        ? `the pickup is ${Math.round(miles)} miles from your home base, outside your ${radius}-mile area`
        : "the pickup is outside your service area";
    }
    case "not_preferred_route":
      return "it isn't one of your preferred routes";
  }
}

/** The notification a driver gets for a new board load they can request. */
export function newLoadAlertText(load: any, compatibility: DriverLoadCompatibility) {
  const reasons = newLoadCheckReasons(compatibility);
  const vehicles = compatibility.capacity.requiredVehicles;
  const from = place(load?.pickupLocation);
  const to = place(load?.deliveryLocation);
  const pickup = pickupDateLabel(load);
  const details = [
    from && to ? `${from} to ${to}` : from || to,
    vehicles > 0 ? `${vehicles} vehicle${vehicles === 1 ? "" : "s"}` : "",
    pickup ? `pickup ${pickup}` : "",
  ].filter(Boolean);
  const intro = `Load ${load?.loadNumber ?? ""} was just posted${details.length ? `: ${details.join(", ")}` : ""}.`;

  if (reasons.length > 0) {
    return {
      type: NEW_LOAD_CHECK_FIRST_TYPE,
      title: "New Load: Check Before Requesting",
      message: `${intro} You can request it, but check first: ${reasons
        .map((reason) => reasonText(reason, compatibility))
        .join("; ")}. Open it to see the details.`,
      reasons,
    };
  }

  // Only claim what was actually compared: a driver without a trailer type or
  // work days on file isn't told the load matches them.
  const fitsTrailer = Boolean(compatibility.trailer.driverTrailerType);
  const onWorkDay = compatibility.availability.status === "match";
  const fit =
    fitsTrailer && onWorkDay
      ? " It fits your trailer, and the pickup is on one of your work days."
      : fitsTrailer
        ? " It fits your trailer."
        : onWorkDay
          ? " The pickup is on one of your work days."
          : "";
  return {
    type: NEW_LOAD_FITS_TYPE,
    title: "New Load You Can Request",
    message: `${intro}${fit} Open it to see the details and request it.`,
    reasons,
  };
}

// A developer's computer connected to the live database must never message
// real drivers about its test loads. Developers run the TypeScript source
// (npm run dev); the live server runs the compiled build, so it keeps sending
// alerts whatever its NODE_ENV or database override says.
function isLocalServerOnLiveDatabase(env: NodeJS.ProcessEnv = process.env): boolean {
  const runningFromSource = __filename.endsWith(".ts");
  return runningFromSource && env.NODE_ENV !== "production" && Boolean(String(env.ALLOW_PRODUCTION_DB ?? "").trim());
}

const DRIVERS_CHECKED_AT_ONCE = 8;

async function forEachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Announces a board load to every driver who could request it. Safe to call
 * more than once: only the first call for a load sends anything. Never throws.
 */
export async function announceNewBoardLoad(loadId: string) {
  const summary = { fits: 0, checkFirst: 0, notEligible: 0 };
  try {
    if (isLocalServerOnLiveDatabase()) {
      logger.warn(
        { loadId },
        "[new-load alerts] Not sent: this local server is connected to the live database, so drivers aren't told about its loads.",
      );
      return summary;
    }

    // Claim the announcement. The load must still be on the board, and it is
    // claimed once, so a quick private/public switch can't announce it twice.
    // timestamps:false keeps updatedAt, so an open edit form stays current.
    const load: any = await Load.findOneAndUpdate(
      {
        _id: loadId,
        status: "Posted",
        "additionalInfo.visibility": { $ne: "private" },
        $or: [{ assignedDriverId: null }, { assignedDriverId: { $exists: false } }],
        boardAlertSentAt: { $exists: false },
      },
      { $set: { boardAlertSentAt: new Date() } },
      { new: true, timestamps: false },
    ).lean();
    if (!load) return summary;
    if (!(await isOrganizationActive(load.organizationId))) return summary;

    const organizationId = String(load.organizationId);
    const alreadyRequested = new Set(
      (load.driverRequests ?? []).map((request: any) => String(request?.driverId ?? "")),
    );

    // The same accounts that can sign in and use the Driver Portal.
    const drivers: any[] = await User.find({
      role: "driver",
      isActive: true,
      isApproved: { $ne: false },
      emailVerified: true,
      onboardingCompleted: true,
    })
      .select("_id")
      .lean();
    const driverIds = drivers
      .map((driver) => String(driver._id))
      .filter((id) => !alreadyRequested.has(id));
    if (driverIds.length === 0) return summary;

    const [profiles, locations] = await Promise.all([
      DriverProfile.find({ userId: { $in: driverIds } }).lean(),
      DriverLocation.find({ userId: { $in: driverIds } })
        .select("userId coords isSharing lastSeenAt")
        .lean(),
    ]);
    const profileOf = new Map((profiles as any[]).map((profile) => [String(profile.userId), profile]));
    const locationOf = new Map((locations as any[]).map((location) => [String(location.userId), location]));

    // Every driver is compared with the same pickup, so its position is looked
    // up once here (the matcher uses pickupCoordinates when it is present).
    const pickupZip = String(load.pickupLocation?.zip ?? "").trim();
    if (/^\d{5}(?:-\d{4})?$/.test(pickupZip)) {
      const pickupCoordinates = await getCoordinatesFromZip(pickupZip.slice(0, 5)).catch(() => null);
      if (pickupCoordinates) load.pickupCoordinates = pickupCoordinates;
    }

    await forEachLimited(driverIds, DRIVERS_CHECKED_AT_ONCE, async (driverId) => {
      try {
        const profile = profileOf.get(driverId) ?? null;

        // The same checks as pressing Request, cheapest first.
        if (!evaluateDriverLoadCompatibility(profile, load).driverRequestAllowed) {
          summary.notEligible++;
          return;
        }
        if (!(await getDriverWorkEligibility(driverId, organizationId)).eligible) {
          summary.notEligible++;
          return;
        }
        const conflicts = await findDriverCommitmentConflicts({
          driverId,
          targetLoad: load,
          excludeLoadId: loadId,
        });
        if (conflicts.length > 0) {
          summary.notEligible++;
          return;
        }

        const compatibility = await evaluateDriverLoadCompatibilityWithRecommendations(
          profile,
          load,
          locationOf.get(driverId) ?? null,
        );
        const alert = newLoadAlertText(load, compatibility);
        await safeCreateNotification({
          userId: driverId,
          organizationId,
          type: alert.type,
          title: alert.title,
          message: alert.message,
          metadata: {
            loadId: String(load._id),
            loadNumber: load.loadNumber,
            route: `/driver/available-loads/${String(load._id)}`,
            checkReasons: alert.reasons,
            // New-load alerts replace each other on the phone instead of
            // replacing an assignment or other load notification.
            pushTag: "new-board-loads",
          },
        });
        if (alert.type === NEW_LOAD_FITS_TYPE) summary.fits++;
        else summary.checkFirst++;
      } catch (err) {
        logger.error({ err, loadId, driverId }, "[new-load alerts] Could not check or notify one driver");
      }
    });

    logger.info({ loadId, loadNumber: load.loadNumber, ...summary }, "[new-load alerts] Drivers told about a new board load");

    // Dispatch may have assigned it (or made it private) while drivers were
    // being told; those alerts must not keep offering it.
    const now: any = await Load.findById(loadId).select("status assignedDriverId additionalInfo.visibility").lean();
    if (!now || now.status !== "Posted" || now.assignedDriverId || now.additionalInfo?.visibility === "private") {
      await markNewLoadAlertsUnavailable(loadId, now?.assignedDriverId ? String(now.assignedDriverId) : null);
    }
  } catch (err) {
    logger.error({ err, loadId }, "[new-load alerts] Failed to announce a new board load");
  }
  return summary;
}

/**
 * Updates the new-load alerts of a load that has left the board (assigned,
 * made private or deleted), so no driver's list keeps offering it. The driver
 * who now has the load is pointed to it in My Loads; everyone else sees it is
 * no longer available. Both are marked read, so the badge drops. Never throws.
 */
export async function markNewLoadAlertsUnavailable(loadId: string, assignedDriverId?: string | null) {
  try {
    const open: any[] = await Notification.find({
      type: { $in: [NEW_LOAD_FITS_TYPE, NEW_LOAD_CHECK_FIRST_TYPE] },
      "metadata.loadId": String(loadId),
      "metadata.boardState": { $exists: false },
    })
      .select("_id userId metadata.loadNumber")
      .lean();
    if (open.length === 0) return 0;

    const loadNumber = String(open[0]?.metadata?.loadNumber ?? "").trim();
    const name = loadNumber ? `Load ${loadNumber}` : "This load";
    const ownerId = assignedDriverId ? String(assignedDriverId) : null;
    const ownAlerts = open.filter((alert) => ownerId && String(alert.userId) === ownerId).map((alert) => alert._id);
    const otherAlerts = open.filter((alert) => !ownerId || String(alert.userId) !== ownerId).map((alert) => alert._id);

    if (otherAlerts.length > 0) {
      await Notification.updateMany(
        { _id: { $in: otherAlerts } },
        {
          $set: {
            type: NEW_LOAD_UNAVAILABLE_TYPE,
            title: "Load No Longer Available",
            message: `${name} was assigned to another driver or taken off the load board, so it can't be requested. You don't need to do anything.`,
            isRead: true,
            "metadata.boardState": "gone",
            "metadata.route": "/driver/available-loads",
          },
        },
      );
    }
    if (ownAlerts.length > 0) {
      await Notification.updateMany(
        { _id: { $in: ownAlerts } },
        {
          $set: {
            title: "Load Now Assigned to You",
            message: `${name} is now assigned to you, so it's no longer on the load board. Open it in My Loads.`,
            isRead: true,
            "metadata.boardState": "assigned_to_you",
            "metadata.route": `/driver/loads/${String(loadId)}`,
          },
        },
      );
    }

    // Open notification lists replace the item and refresh their counts.
    const updated: any[] = await Notification.find({ _id: { $in: open.map((alert) => alert._id) } }).lean();
    for (const notification of updated) emitToUser(String(notification.userId), "notification:updated", notification);
    return updated.length;
  } catch (err) {
    logger.error({ err, loadId }, "[new-load alerts] Could not mark alerts for a load that left the board");
    return 0;
  }
}
