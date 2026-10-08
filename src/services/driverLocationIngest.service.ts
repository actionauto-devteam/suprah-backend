import DriverLocation, { IDriverLocation } from "../models/DriverLocation.model";
import DriverProfile from "../models/DriverProfile.model";
import LoadTripPoint from "../models/LoadTripPoint.model";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";
import { countBy, driverTrackerMetrics } from "../utils/metrics";
import {
  DriverGpsTrackingLoad,
  emitDriverLocationToResponsibleDispatchers,
  getDriverGpsTrackingLoads,
} from "./driverLocationAccess.service";
import { clearDriverExactLocationIfUnneeded } from "./driverLocationRetention.service";
import {
  finalizeDriverStatusChangeIfClear,
  getDriverLocationRequirement,
  getDriverStatusContext,
} from "./driverStatusTransition.service";

/*
 * One pipeline for every driver location source: the Driver Portal in the
 * browser, Traccar Client (through the company's Traccar Server) and the
 * Suprah Driver Tracker app (source "app").
 * Each source only has to turn its message into a NormalizedDriverLocation;
 * validation, the tracking-relationship rule, ordering, source priority,
 * storage and delivery to authorized viewers all happen here.
 */

export type DriverLocationSource = "browser" | "traccar" | "app";

/**
 * Phone sources (Traccar Client and the Suprah Driver Tracker app) keep
 * reporting in the background and buffer while offline, so they are the
 * primary source over the browser.
 */
export const PHONE_SOURCES: DriverLocationSource[] = ["traccar", "app"];

/**
 * A single measurement, already tied to a Suprah driver through trusted
 * records (the signed-in driver, or an approved device link). A driver or
 * organization id sent by a provider is never trusted.
 */
export interface NormalizedDriverLocation {
  driverId: string;
  source: DriverLocationSource;
  /** The provider's device id. Identifies the phone, never the driver. */
  sourceDeviceId?: string | null;
  /** WGS84 decimal degrees. */
  lat: number;
  lng: number;
  /** When the phone measured the position. */
  measuredAt: Date;
  /** When Suprah received it. */
  receivedAt: Date;
  /** Metres. */
  accuracy?: number | null;
  /** Metres per second. */
  speed?: number | null;
  /** Degrees clockwise from north, 0 to 360. */
  heading?: number | null;
  /** Browser only: Manual GPS kept on without an active load. */
  manualSharingOptIn?: boolean;
  /** Browser only: the live status reported by the Driver Portal. */
  requestedStatus?: string;
  /** Browser only: the organization selected in the Driver Portal. */
  fallbackOrganizationId?: string;
}

export type LocationRejection =
  | "invalid_location"
  | "future_reading"
  | "too_old"
  | "no_tracking_relationship"
  | "older_than_stored"
  | "primary_source_fresh"
  | "sharing_stopped";

/** A reading this far in the future comes from a wrong clock. */
export const FUTURE_TOLERANCE_MS = 60_000;
/** Browser readings are sent as they're measured; older ones weren't measured "now". */
export const BROWSER_MAX_AGE_MS = 120_000;
/**
 * Traccar Client buffers positions while the phone is offline. The newest late
 * one may become the driver's Last known position (shown with its real age,
 * never as live), up to this age.
 */
export const BUFFERED_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * Phone sources (Traccar, the tracking app) are primary (business rule,
 * 2026-09-30). While their latest
 * reading is this recent, a browser reading doesn't replace it.
 */
export const PRIMARY_SOURCE_FRESH_MS = 60_000;

const LIVE_STATUSES = ["on-route", "idle", "on-break", "waiting", "offline"];

/**
 * Which loads make a driver's GPS relevant, per organization, and whether
 * Dispatch requires it right now. Moved unchanged from driverTracking.controller.
 */
export async function getDriverGpsPolicyAcrossOrganizations(
  driverId: string,
  fallbackOrganizationId?: string,
  // GPS heartbeats (up to 12 a minute) skip the lazy status finalization: it
  // is a write, and it is already retried by the driver's status polling and
  // the Driver Tracker directory.
  options: { finalize?: boolean } = {},
) {
  const finalize = options.finalize !== false;
  const trackingLoads = await getDriverGpsTrackingLoads(driverId);
  const byOrg = new Map<string, string[]>();
  for (const load of trackingLoads) {
    const orgId = String(load.organizationId ?? "").trim();
    if (!orgId) continue;
    const ids = byOrg.get(orgId) ?? [];
    ids.push(String(load._id));
    byOrg.set(orgId, ids);
  }

  let operationalStatus: "active" | "on_leave" | "maintenance" = "active";
  let required = false;
  let reason: "active_load" | "dispatch_retained_load" | null = null;
  const requiredLoadIds = new Set<string>();
  const retainedLoadIds = new Set<string>();
  let emergencyReleaseActive = false;

  if (finalize) {
    for (const organizationId of byOrg.keys()) {
      await finalizeDriverStatusChangeIfClear(driverId, organizationId);
    }
  }
  // Work Availability is platform-wide, so one read serves every organization.
  const statusContext = byOrg.size > 0
    ? await getDriverStatusContext(driverId)
    : null;

  for (const [organizationId, activeLoadIds] of byOrg.entries()) {
    if (!statusContext) break;
    operationalStatus = statusContext.operationalStatus;
    if (statusContext.emergencyReleaseActive) emergencyReleaseActive = true;
    const requirement = await getDriverLocationRequirement(
      driverId,
      organizationId,
      {
        operationalStatus: statusContext.operationalStatus,
        emergencyReleaseActive: statusContext.emergencyReleaseActive,
        activeLoadIds,
      },
    );

    if (!requirement.required) continue;
    required = true;
    if (requirement.reason === "dispatch_retained_load") {
      reason = "dispatch_retained_load";
      for (const loadId of requirement.retainedLoadIds) {
        retainedLoadIds.add(loadId);
        requiredLoadIds.add(loadId);
      }
    } else {
      if (!reason) reason = "active_load";
      for (const loadId of activeLoadIds) requiredLoadIds.add(loadId);
    }
  }

  if (byOrg.size === 0) {
    if (fallbackOrganizationId) {
      const statusContext = await getDriverStatusContext(driverId, fallbackOrganizationId);
      operationalStatus = statusContext.operationalStatus;
    } else {
      const profile: any = await DriverProfile.findOne({ userId: driverId })
        .select("operationalStatus")
        .lean();
      operationalStatus =
        profile?.operationalStatus === "on_leave" || profile?.operationalStatus === "maintenance"
          ? profile.operationalStatus
          : "active";
    }
  }

  return {
    trackingLoads,
    operationalStatus,
    required,
    reason,
    requiredLoadIds: [...requiredLoadIds],
    retainedLoadIds: [...retainedLoadIds],
    emergencyReleaseActive,
  };
}

type DriverGpsPolicy = Awaited<ReturnType<typeof getDriverGpsPolicyAcrossOrganizations>>;

export type LocationIngestResult =
  | {
      accepted: true;
      location: IDriverLocation;
      policy: DriverGpsPolicy;
      hasTrackingRelationship: boolean;
      /** Users the position was sent to live. */
      viewerIds: string[];
    }
  | { accepted: false; reason: LocationRejection };

const inRange = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;

// Browser counters keep the names they had before this pipeline existed.
const BROWSER_METRIC_NAMES: Partial<Record<LocationRejection, string>> = {
  no_tracking_relationship: "no_active_load",
};

function rejected(source: DriverLocationSource, reason: LocationRejection): LocationIngestResult {
  const metric = source === "browser" ? BROWSER_METRIC_NAMES[reason] ?? reason : `${source}:${reason}`;
  countBy(driverTrackerMetrics.heartbeatRejects, metric);
  return { accepted: false, reason };
}

/**
 * Adds the reading to the trip history of each load that was being tracked
 * when it was measured (from the moment the driver accepted it). Never fails
 * the location update: history is best effort, and a repeated reading is
 * stored once.
 */
async function recordTripHistory(
  input: NormalizedDriverLocation,
  measuredAt: Date,
  trackingLoads: DriverGpsTrackingLoad[],
) {
  const loads = trackingLoads.filter((load) => {
    const acceptedMs = load.acceptedAt ? new Date(load.acceptedAt).getTime() : Number.NaN;
    return !Number.isFinite(acceptedMs) || measuredAt.getTime() >= acceptedMs;
  });
  if (!loads.length) return;

  try {
    await LoadTripPoint.insertMany(
      loads.map((load) => ({
        loadId: load._id,
        organizationId: load.organizationId,
        driverId: input.driverId,
        lat: input.lat,
        lng: input.lng,
        measuredAt,
        receivedAt: input.receivedAt,
        accuracy: inRange(input.accuracy, 0, Number.MAX_SAFE_INTEGER),
        speed: inRange(input.speed, 0, 1_000),
        heading: inRange(input.heading, 0, 360),
        source: input.source,
        loadStatus: String(load.status ?? ""),
      })),
      { ordered: false },
    );
  } catch (error: any) {
    const writeErrors: any[] = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
    const onlyRepeats =
      error?.code === 11000 ||
      (writeErrors.length > 0 && writeErrors.every((item) => (item?.code ?? item?.err?.code) === 11000));
    if (!onlyRepeats) {
      logger.warn(
        { driverId: input.driverId, source: input.source, error: error instanceof Error ? error.message : "unknown" },
        "Trip history point could not be saved",
      );
    }
  }
}

export async function ingestDriverLocation(
  input: NormalizedDriverLocation,
): Promise<LocationIngestResult> {
  const { driverId, source } = input;
  const measuredMs = input.measuredAt instanceof Date ? input.measuredAt.getTime() : Number.NaN;
  if (inRange(input.lat, -90, 90) === null || inRange(input.lng, -180, 180) === null || !Number.isFinite(measuredMs)) {
    return rejected(source, "invalid_location");
  }
  const now = Date.now();
  if (measuredMs > now + FUTURE_TOLERANCE_MS) return rejected(source, "future_reading");
  if (now - measuredMs > (source === "browser" ? BROWSER_MAX_AGE_MS : BUFFERED_MAX_AGE_MS)) {
    return rejected(source, "too_old");
  }

  const policy = await getDriverGpsPolicyAcrossOrganizations(driverId, input.fallbackOrganizationId, {
    finalize: false,
  });
  const hasTrackingRelationship = policy.trackingLoads.length > 0;
  const manualSharingOptIn = source === "browser" && input.manualSharingOptIn === true;

  // A stale watcher (or a phone still reporting) can send one more reading
  // right after the last Load relationship ends. Without an explicit Manual
  // GPS opt-in, don't recreate exact coordinates that lifecycle cleanup removed.
  if (!hasTrackingRelationship && !manualSharingOptIn) {
    await clearDriverExactLocationIfUnneeded(
      driverId,
      source === "browser" ? "heartbeat_without_tracking_relationship" : `${source}_without_tracking_relationship`,
    );
    return rejected(source, "no_tracking_relationship");
  }

  const requestedStatus =
    input.requestedStatus && LIVE_STATUSES.includes(input.requestedStatus) ? input.requestedStatus : undefined;
  const nextStatus =
    policy.operationalStatus === "on_leave"
      ? "offline"
      : policy.operationalStatus === "maintenance"
        ? "waiting"
        : requestedStatus;

  // DriverLocation is a platform-wide driver record. organizationId remains a
  // legacy hint only and is never used to authorize who may read coordinates.
  const contextOrganizationId =
    String(policy.trackingLoads[0]?.organizationId ?? input.fallbackOrganizationId ?? "").trim() || undefined;
  const measuredAt = new Date(measuredMs);
  const locationSet: Record<string, unknown> = {
    coords: { lat: input.lat, lng: input.lng },
    locationRecordedAt: measuredAt,
    accuracy: inRange(input.accuracy, 0, Number.MAX_SAFE_INTEGER),
    speed: inRange(input.speed, 0, 1_000),
    heading: inRange(input.heading, 0, 360),
    source,
    sourceDeviceId: input.sourceDeviceId ?? null,
    lastSeenAt: new Date(),
    isSharing: true,
    offlineAlertSentAt: null,
    ...(nextStatus ? { status: nextStatus } : {}),
  };
  // Manual GPS is a Driver Portal choice; other sources leave it as it is.
  if (source === "browser") locationSet.manualSharingOptIn = manualSharingOptIn;
  if (contextOrganizationId) locationSet.organizationId = contextOrganizationId;

  const locationUpdate: Record<string, unknown> = { $set: locationSet };
  if (!nextStatus) locationUpdate.$setOnInsert = { status: "idle" };

  const conditions: Record<string, unknown>[] = [
    // The newest measurement wins, not the last message to arrive.
    { $or: [{ locationRecordedAt: null }, { locationRecordedAt: { $lte: measuredAt } }] },
    // A reading already on its way when the driver turned GPS off must not
    // switch sharing back on.
    { $or: [{ sharingStoppedAt: null }, { sharingStoppedAt: { $lte: input.receivedAt } }] },
  ];
  if (source === "browser") {
    // A browser reading only replaces a phone one after the phone has been
    // quiet for a while, so the marker doesn't jump between the two.
    conditions.push({
      $or: [
        { source: { $nin: PHONE_SOURCES } },
        { locationRecordedAt: null },
        { locationRecordedAt: { $lte: new Date(measuredMs - PRIMARY_SOURCE_FRESH_MS) } },
      ],
    });
  }

  let location: IDriverLocation | null;
  try {
    location = await DriverLocation.findOneAndUpdate(
      { userId: driverId, $and: conditions },
      locationUpdate,
      { new: true, upsert: true },
    );
  } catch (error: any) {
    // The driver's row exists but didn't qualify for this reading.
    if (error?.code === 11000) {
      const stored: any = await DriverLocation.findOne({ userId: driverId })
        .select("source locationRecordedAt sharingStoppedAt")
        .lean();
      if (stored?.sharingStoppedAt && new Date(stored.sharingStoppedAt) > input.receivedAt) {
        return rejected(source, "sharing_stopped");
      }
      const storedMs = stored?.locationRecordedAt ? new Date(stored.locationRecordedAt).getTime() : Number.NaN;
      if (source === "browser" && PHONE_SOURCES.includes(stored?.source) && Number.isFinite(storedMs) && storedMs <= measuredMs) {
        return rejected(source, "primary_source_fresh");
      }
      // A late phone reading (the phone was offline) doesn't move the live
      // position backwards, but it still fills in the trip history.
      if (PHONE_SOURCES.includes(source)) await recordTripHistory(input, measuredAt, policy.trackingLoads);
      return rejected(source, "older_than_stored");
    }
    throw error;
  }
  if (!location) {
    throw new ApiError(500, "We couldn't save your location right now. Check your internet connection and try again.");
  }

  // Exact coordinates only go to viewers of an Accepted, Picked Up or
  // In-Transit load (reusing the tracking loads read above).
  const viewerIds = await emitDriverLocationToResponsibleDispatchers(
    driverId,
    {
      coords: location.coords,
      status: location.status,
      isSharing: true,
      lastSeenAt: location.lastSeenAt,
      locationRecordedAt: location.locationRecordedAt ?? null,
      accuracy: location.accuracy ?? null,
      source,
    },
    policy.trackingLoads,
  );
  await recordTripHistory(input, measuredAt, policy.trackingLoads);

  return { accepted: true, location, policy, hasTrackingRelationship, viewerIds };
}
