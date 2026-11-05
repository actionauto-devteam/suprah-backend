import mongoose from "mongoose";
import Load from "../models/Load.model";
import Quote from "../models/Quote.model";
import { findQuoteFollowers } from "./shipmentFollower";
import { CHAT_LOAD_FIELDS, loadDispatchers, type ChatLoad } from "./shipmentChat.service";
import { LIVE_MAP_STATUSES } from "./customerShipmentTracking";
import { APPROXIMATE_POSITION_METERS } from "./loadRoute.service";
import { emitToUser } from "../utils/socketEmitter";
import logger from "../utils/logger";

/*
 * The live map on My Shipments moves with the driver: each time the driver's
 * phone reports a position, the customer who follows a shipment on that
 * driver's truck gets it right away, the same moment Driver Tracker does.
 *
 * Only while the car is on the truck (Picked Up, In-Transit), only to the
 * customer who follows that shipment, and only what the map already shows:
 * the position, when it was measured and whether it's rough. Never the
 * driver's speed, heading, breaks or anything else.
 */

export const CUSTOMER_LOCATION_EVENT = "customer-shipment:location";

/** Staff unlinked a shipment from the customer's portal, or linked it again. */
export const CUSTOMER_SHIPMENT_CHANGED_EVENT = "customer-shipment:changed";

/** Who follows each load is kept this long, so a heartbeat (up to 12 a minute) rarely reads the database. */
export const FOLLOWER_CACHE_MS = 60_000;

interface LiveFollower {
  customerId: string;
  quoteId: string;
}

const followersByLoad = new Map<string, { expiresAt: number; followers: LiveFollower[] }>();

/** Drops what's kept, for example after staff unlink or link a customer again. */
export function forgetShipmentFollowers(): void {
  followersByLoad.clear();
}

const toId = (value: unknown) => String(value ?? "").trim();

async function followersOf(loadIds: string[], now: number): Promise<Map<string, LiveFollower[]>> {
  const result = new Map<string, LiveFollower[]>();
  const missing: string[] = [];
  // Delivered loads stop sending positions; their entries are dropped here.
  if (followersByLoad.size > 500) {
    for (const [id, kept] of followersByLoad) if (kept.expiresAt <= now) followersByLoad.delete(id);
  }
  for (const id of loadIds) {
    const kept = followersByLoad.get(id);
    if (kept && kept.expiresAt > now) result.set(id, kept.followers);
    else missing.push(id);
  }
  if (missing.length === 0) return result;

  const loads = await Load.find({ _id: { $in: missing } })
    .select("_id quoteId organizationId")
    .lean<Array<{ _id: unknown; quoteId?: unknown; organizationId?: unknown }>>();
  const quoteIds = [...new Set(loads.map((load) => toId(load.quoteId)).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const quotes = quoteIds.length
    ? await Quote.find({ _id: { $in: quoteIds } })
        .select("_id organizationId source requestedBy email portalShareOff")
        .lean<Array<{ _id: unknown; organizationId?: unknown; source?: string; requestedBy?: unknown; email?: string; portalShareOff?: boolean }>>()
    : [];
  const quoteById = new Map(quotes.map((quote) => [toId(quote._id), quote]));
  const followers = await findQuoteFollowers(quotes);

  for (const id of missing) {
    const load = loads.find((item) => toId(item._id) === id);
    const quote = load ? quoteById.get(toId(load.quoteId)) : undefined;
    // The quote must be the load's own dealership's, as on the map itself.
    const follower = quote && toId(quote.organizationId) === toId(load?.organizationId) ? followers.get(toId(quote._id)) : undefined;
    const list = follower && quote ? [{ customerId: follower.id, quoteId: toId(quote._id) }] : [];
    followersByLoad.set(id, { expiresAt: now + FOLLOWER_CACHE_MS, followers: list });
    result.set(id, list);
  }
  return result;
}

/**
 * Sends the driver's new position to the customers following the shipments
 * on their truck. Never throws: the driver's location is already saved and
 * Dispatch already has it. Returns how many customers were sent it.
 */
export async function emitLocationToShipmentFollowers(
  trackingLoads: Array<{ _id: unknown; status?: unknown }>,
  location: { coords?: { lat?: unknown; lng?: unknown } | null; locationRecordedAt?: unknown; accuracy?: unknown } | null | undefined,
  now = Date.now(),
): Promise<number> {
  try {
    const live = trackingLoads.filter((load) => LIVE_MAP_STATUSES.has(String(load.status ?? "")));
    if (live.length === 0 || !location?.coords) return 0;
    const lat = Number(location.coords.lat);
    const lng = Number(location.coords.lng);
    const measured = location.locationRecordedAt ? new Date(location.locationRecordedAt as string | Date) : null;
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !measured || !Number.isFinite(measured.getTime())) return 0;

    const driver = {
      position: { lat, lng },
      measuredAt: measured.toISOString(),
      approximate: typeof location.accuracy === "number" && location.accuracy > APPROXIMATE_POSITION_METERS,
    };
    const followers = await followersOf([...new Set(live.map((load) => toId(load._id)))], now);
    let sent = 0;
    for (const list of followers.values()) {
      for (const follower of list) {
        emitToUser(follower.customerId, CUSTOMER_LOCATION_EVENT, { quoteId: follower.quoteId, driver });
        sent += 1;
      }
    }
    return sent;
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : "unknown" }, "[CustomerShipmentLive] Live position not sent to customers");
    return 0;
  }
}

/**
 * After staff Unlink a shipment from the customer's portal or Link it again,
 * everyone involved sees it at once instead of at their next refresh: the
 * customer's My Shipments (the shipment and its chats go or come back), and
 * the load's driver and dispatcher (their Message customer button and
 * Customers section). Never throws: the change is already saved.
 */
export async function announceShipmentSharing(
  organizationId: string,
  quoteId: string,
  customerId: string | null,
  shared: boolean,
): Promise<void> {
  try {
    if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
      emitToUser(customerId, CUSTOMER_SHIPMENT_CHANGED_EVENT, { quoteId, shared });
    }
    if (!mongoose.Types.ObjectId.isValid(quoteId)) return;
    const load = await Load.findOne({ quoteId, organizationId })
      .sort({ createdAt: -1 })
      .select(CHAT_LOAD_FIELDS)
      .lean<ChatLoad>();
    if (!load) return;
    const dispatcherId = (await loadDispatchers([load])).get(String(load._id))?.id ?? null;
    const driverId = toId(load.assignedDriverId);
    const loadId = String(load._id);
    if (driverId && mongoose.Types.ObjectId.isValid(driverId)) {
      emitToUser(driverId, "shipment-chat:changed", { loadId, quoteId, kind: "driver" });
    }
    if (dispatcherId && dispatcherId !== driverId) {
      emitToUser(dispatcherId, "shipment-chat:changed", { loadId, quoteId, kind: "dispatcher" });
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : "unknown" }, "[CustomerShipmentLive] Sharing change not announced");
  }
}
