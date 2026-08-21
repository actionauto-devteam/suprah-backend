import DriverProfile from "../models/DriverProfile.model";
import { ApiError } from "../utils/ApiError";
import {
  DriverRouteCompatibilitySignals,
  evaluateDriverRouteCompatibility,
  getDriverLocationForMatching,
} from "./driverRouteMatching.service";

export const DRIVER_LOAD_COMPATIBILITY_ERROR_TYPE =
  "driver_load_compatibility" as const;

const VALID_WEEKDAYS = new Set([
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
]);

export type AvailabilityCompatibilityStatus =
  | "match"
  | "off_schedule"
  | "unknown";
export type CapacityCompatibilityStatus = "match" | "exceeded" | "unknown";
export type TrailerCompatibilityStatus = "match" | "mismatch" | "unknown";

const EMPTY_ROUTE_SIGNALS: DriverRouteCompatibilitySignals = {
  serviceArea: {
    status: "unknown",
    serviceRadiusMiles: null,
    distanceFromHomeBaseToPickupMiles: null,
    homeBaseLabel: null,
  },
  preferredRoute: {
    status: "unknown",
    originState: null,
    destinationState: null,
    matchedRoute: null,
    preferredRoutes: [],
  },
  proximity: {
    distanceToPickupMiles: null,
    source: null,
    lastSeenAt: null,
  },
};

export interface DriverLoadCompatibility extends DriverRouteCompatibilitySignals {
  availability: {
    status: AvailabilityCompatibilityStatus;
    pickupDate: string | null;
    pickupDay: string | null;
    availableDays: string[];
  };
  capacity: {
    status: CapacityCompatibilityStatus;
    requiredVehicles: number;
    maxVehicles: number | null;
  };
  trailer: {
    status: TrailerCompatibilityStatus;
    requiredTrailerType: string | null;
    driverTrailerType: string | null;
  };
  requiresAvailabilityOverride: boolean;
  requiresCapacityOverride: boolean;
  driverRequestAllowed: boolean;
  recommended: boolean;
  warnings: string[];
}

export interface CompatibilityOverrideOptions {
  overrideAvailability?: boolean;
  overrideCapacity?: boolean;
}

function normalizeWeekdays(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return [
    ...new Set(
      value
        .map((day) => String(day ?? "").trim().toLowerCase())
        .filter((day) => VALID_WEEKDAYS.has(day)),
    ),
  ];
}

function normalizeTrailerType(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return normalized || null;
}

function pickupDateFromLoad(load: any): Date | null {
  const raw =
    load?.dates?.firstAvailable ??
    load?.dates?.pickupDeadline ??
    load?.requestedPickupDate ??
    null;

  if (!raw) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function weekdayForStoredLoadDate(date: Date | null): string | null {
  if (!date) return null;

  // Load schedule fields originate from HTML `type=date` values (YYYY-MM-DD).
  // Mongoose stores those as UTC-midnight Dates. Reading the weekday in a US
  // timezone would move many values to the PREVIOUS calendar day. UTC keeps
  // the exact calendar date the dispatcher selected.
  return [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ][date.getUTCDay()] ?? null;
}

function isoOrNull(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

export function evaluateDriverLoadCompatibility(
  profile: any | null | undefined,
  load: any,
  routeSignals: DriverRouteCompatibilitySignals = EMPTY_ROUTE_SIGNALS,
): DriverLoadCompatibility {
  const availableDays = normalizeWeekdays(profile?.availableDays);
  const pickupDate = pickupDateFromLoad(load);
  const pickupDay = weekdayForStoredLoadDate(pickupDate);

  const availabilityStatus: AvailabilityCompatibilityStatus =
    availableDays.length === 0 || !pickupDay
      ? "unknown"
      : availableDays.includes(pickupDay)
        ? "match"
        : "off_schedule";

  const requiredVehicles = Array.isArray(load?.vehicles)
    ? load.vehicles.length
    : Number.isFinite(Number(load?.vehicleCount))
      ? Math.max(0, Number(load.vehicleCount))
      : 0;

  const configuredCapacity = Number(profile?.maxVehicleCapacity);
  const maxVehicles =
    Number.isFinite(configuredCapacity) && configuredCapacity > 0
      ? configuredCapacity
      : null;

  const capacityStatus: CapacityCompatibilityStatus =
    requiredVehicles <= 0 || maxVehicles == null
      ? "unknown"
      : maxVehicles >= requiredVehicles
        ? "match"
        : "exceeded";

  const requiredTrailerType = normalizeTrailerType(
    load?.trailerType ?? load?.trailerTypeRequired,
  );
  const driverTrailerType = normalizeTrailerType(profile?.trailerType);
  const trailerStatus: TrailerCompatibilityStatus =
    !requiredTrailerType || !driverTrailerType
      ? "unknown"
      : requiredTrailerType === driverTrailerType
        ? "match"
        : "mismatch";

  const warnings: string[] = [];

  if (availabilityStatus === "off_schedule") {
    warnings.push("outside_regular_availability");
  } else if (availabilityStatus === "unknown") {
    warnings.push(
      availableDays.length === 0
        ? "availability_not_configured"
        : "pickup_date_not_configured",
    );
  }

  if (capacityStatus === "exceeded") {
    warnings.push("vehicle_capacity_exceeded");
  } else if (capacityStatus === "unknown") {
    warnings.push("vehicle_capacity_unknown");
  }

  if (trailerStatus === "mismatch") {
    warnings.push("trailer_mismatch");
  }

  const requiresAvailabilityOverride = availabilityStatus === "off_schedule";
  const requiresCapacityOverride = capacityStatus !== "match";

  return {
    availability: {
      status: availabilityStatus,
      pickupDate: isoOrNull(pickupDate),
      pickupDay,
      availableDays,
    },
    capacity: {
      status: capacityStatus,
      requiredVehicles,
      maxVehicles,
    },
    trailer: {
      status: trailerStatus,
      requiredTrailerType,
      driverTrailerType,
    },
    serviceArea: routeSignals.serviceArea,
    preferredRoute: routeSignals.preferredRoute,
    proximity: routeSignals.proximity,
    requiresAvailabilityOverride,
    requiresCapacityOverride,
    // Drivers may explicitly work outside their regular schedule, but they
    // cannot self-request work that exceeds or has unknown equipment capacity.
    driverRequestAllowed: capacityStatus === "match",
    // IMPORTANT: service area, preferred routes, and pickup proximity are
    // recommendation signals only. They never turn a compatible load into a
    // blocked load and never create an additional override requirement.
    recommended:
      availabilityStatus !== "off_schedule" &&
      capacityStatus === "match" &&
      trailerStatus !== "mismatch",
    warnings,
  };
}

export async function evaluateDriverLoadCompatibilityWithRecommendations(
  profile: any | null | undefined,
  load: any,
  location?: any | null,
): Promise<DriverLoadCompatibility> {
  const routeSignals = await evaluateDriverRouteCompatibility(
    profile,
    load,
    location,
  );
  return evaluateDriverLoadCompatibility(profile, load, routeSignals);
}

export async function getDriverLoadCompatibility(
  driverId: string,
  organizationId: string,
  load: any,
): Promise<DriverLoadCompatibility> {
  const [profile, location] = await Promise.all([
    // A driver has one profile, not one per org (shared pool).
    DriverProfile.findOne({ userId: driverId }).lean(),
    getDriverLocationForMatching(driverId, organizationId),
  ]);

  return evaluateDriverLoadCompatibilityWithRecommendations(
    profile,
    load,
    location,
  );
}

function compatibilityError(
  message: string,
  compatibility: DriverLoadCompatibility,
) {
  return new ApiError(409, message, [
    {
      type: DRIVER_LOAD_COMPATIBILITY_ERROR_TYPE,
      compatibility,
    },
  ]);
}

export async function assertDriverLoadCompatibility(params: {
  driverId: string;
  organizationId: string;
  load: any;
  actor: "driver" | "dispatcher";
  overrides?: CompatibilityOverrideOptions;
}) {
  const { driverId, organizationId, load, actor, overrides = {} } = params;

  // Assignment/request mutations only need the authoritative blocking rules.
  // Keep service-area / preferred-route / proximity geocoding out of this
  // mutation path so a slow external geocoder can never delay assigning a
  // load. Recommendation signals are resolved by the read-only preview/list
  // endpoints instead.
  // A driver has one profile, not one per org (shared pool).
  const profile = await DriverProfile.findOne({ userId: driverId }).lean();
  const compatibility = evaluateDriverLoadCompatibility(profile, load);

  if (actor === "driver") {
    if (compatibility.capacity.status === "exceeded") {
      throw compatibilityError(
        `This load requires capacity for ${compatibility.capacity.requiredVehicles} vehicle${compatibility.capacity.requiredVehicles === 1 ? "" : "s"}, but your configured equipment capacity is ${compatibility.capacity.maxVehicles ?? "not available"}. Contact Dispatch if your equipment profile needs to be updated.`,
        compatibility,
      );
    }

    if (compatibility.capacity.status === "unknown") {
      throw compatibilityError(
        "Your vehicle capacity is not configured clearly enough to verify this load. Update your Equipment profile or contact Dispatch before requesting it.",
        compatibility,
      );
    }

    if (
      compatibility.requiresAvailabilityOverride &&
      overrides.overrideAvailability !== true
    ) {
      const pickupDay = compatibility.availability.pickupDay;
      throw compatibilityError(
        `This pickup is scheduled for ${pickupDay ? pickupDay[0].toUpperCase() + pickupDay.slice(1) : "a day outside your regular schedule"}, which is outside your regular availability. Confirm that you want to request it anyway.`,
        compatibility,
      );
    }

    return compatibility;
  }

  const missingAvailabilityOverride =
    compatibility.requiresAvailabilityOverride &&
    overrides.overrideAvailability !== true;
  const missingCapacityOverride =
    compatibility.requiresCapacityOverride && overrides.overrideCapacity !== true;

  if (missingAvailabilityOverride || missingCapacityOverride) {
    const messages: string[] = [];
    if (missingAvailabilityOverride) {
      const pickupDay = compatibility.availability.pickupDay;
      messages.push(
        pickupDay
          ? `the pickup falls on ${pickupDay}, outside the driver's regular availability`
          : "the pickup is outside the driver's regular availability",
      );
    }

    if (missingCapacityOverride) {
      if (compatibility.capacity.status === "exceeded") {
        messages.push(
          `the load requires ${compatibility.capacity.requiredVehicles} vehicle${compatibility.capacity.requiredVehicles === 1 ? "" : "s"} but the driver's configured capacity is ${compatibility.capacity.maxVehicles}`,
        );
      } else {
        messages.push("the driver's vehicle capacity could not be verified");
      }
    }

    throw compatibilityError(
      `Compatibility review required: ${messages.join("; ")}. Confirm the override before continuing.`,
      compatibility,
    );
  }

  return compatibility;
}