import mongoose from "mongoose";
import Quote from "../models/Quote.model";
import Load from "../models/Load.model";
import DriverLocation from "../models/DriverLocation.model";
import { findQuoteFollower } from "./shipmentFollower";
import { getCustomerLoadRoute, pinOf, stopAddressText, APPROXIMATE_POSITION_METERS, type RouteCoordinate } from "./loadRoute.service";
import { MAX_PLACE_QUERY_LENGTH, positionOf } from "./placeLookup.service";
import { ApiError } from "../utils/ApiError";

/*
 * The live map on My Shipments (decided 2026-11-05): from pickup until
 * delivery, the customer who follows a shipment sees where the driver
 * carrying their car is, the delivery spot, and (when road routes are on) the
 * route and arrival time, with "Running late" when the delivery deadline is
 * at risk. Never the driver's breaks or "stopped for N minutes", their speed,
 * the pickup, or anything before pickup or after delivery.
 */

/** Where the driver is shown to customers: only while the car is on the truck. */
export const LIVE_MAP_STATUSES = new Set(["Picked Up", "In-Transit"]);

export const SHIPMENT_NOT_FOUND = "We couldn't find this shipment in your account. Refresh My Shipments and try again.";

export interface CustomerTrackingView {
  /** False before pickup and after delivery or cancellation: no map then. */
  live: boolean;
  driver: {
    position: { lat: number; lng: number };
    /** When the driver's phone reported this position. */
    measuredAt: string;
    /** The position may be off by more than 1 km. */
    approximate: boolean;
  } | null;
  delivery: { lat: number; lng: number } | null;
  /** Null while road routes are off or no route could be worked out. */
  eta: {
    arrivalAt: string;
    /** The delivery deadline is at risk or already missed. */
    runningLate: boolean;
    /** When the arrival time was worked out. */
    updatedAt: string;
  } | null;
  /** The road from the driver to the delivery, when there's a route. */
  route: RouteCoordinate[] | null;
}

const NOT_LIVE: CustomerTrackingView = { live: false, driver: null, delivery: null, eta: null, route: null };

const isoOrNull = (value: unknown) => {
  if (!value) return null;
  const time = new Date(value as string | Date).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/**
 * Where the delivery point goes on the map, the same way Driver Tracker places
 * a stop: the pin staff placed in Create Load, otherwise the delivery address
 * looked up (kept for an hour, so a customer watching the map doesn't look it
 * up again each minute). Null when neither works: the map then shows only the
 * driver.
 */
async function deliverySpot(place: Record<string, any> | null | undefined): Promise<{ lat: number; lng: number } | null> {
  const pin = pinOf(place);
  if (pin) return pin;
  const address = stopAddressText(place);
  if (!address) return null;
  return positionOf(address.slice(0, MAX_PLACE_QUERY_LENGTH)).catch(() => null);
}

/**
 * The live map for one of the customer's own shipments. A shipment that isn't
 * theirs (or was unlinked) answers "not found", the same as one that doesn't
 * exist, so nobody can learn about other shipments.
 */
export async function customerShipmentTracking(customerId: string, quoteId: unknown): Promise<CustomerTrackingView> {
  const id = String(quoteId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(customerId)) throw new ApiError(404, SHIPMENT_NOT_FOUND);

  const quote = await Quote.findById(id)
    .select("organizationId source requestedBy email portalShareOff")
    .lean<{ organizationId?: string; source?: string; requestedBy?: unknown; email?: string; portalShareOff?: boolean }>();
  const follower = await findQuoteFollower(quote);
  if (!quote || !follower || follower.id !== customerId) throw new ApiError(404, SHIPMENT_NOT_FOUND);

  // The newest load for this quote, from the quote's own dealership.
  const load = await Load.findOne({ quoteId: id, organizationId: quote.organizationId })
    .sort({ createdAt: -1 })
    .select("_id status assignedDriverId pickupLocation deliveryLocation dates")
    .lean<any>();
  if (!load || !LIVE_MAP_STATUSES.has(String(load.status)) || !load.assignedDriverId) return NOT_LIVE;

  const [location, route] = await Promise.all([
    DriverLocation.findOne({ userId: load.assignedDriverId })
      .select("coords locationRecordedAt accuracy")
      .lean<any>(),
    getCustomerLoadRoute(load).catch(() => null),
  ]);

  const coords = location?.coords;
  const measuredAt = isoOrNull(location?.locationRecordedAt);
  const driver =
    coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lng) && measuredAt
      ? {
          position: { lat: Number(coords.lat), lng: Number(coords.lng) },
          measuredAt,
          approximate: typeof location.accuracy === "number" && location.accuracy > APPROXIMATE_POSITION_METERS,
        }
      : null;

  const routed = route && route.available ? route : null;
  return {
    live: true,
    driver,
    delivery: routed?.route?.stops.delivery ?? (await deliverySpot(load.deliveryLocation)),
    eta: routed
      ? {
          arrivalAt: routed.arrivalAt,
          runningLate: routed.deadline?.status === "at_risk" || routed.deadline?.status === "late",
          updatedAt: routed.computedAt,
        }
      : null,
    route: routed?.route?.ahead?.length ? routed.route.ahead : null,
  };
}
