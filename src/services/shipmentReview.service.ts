import mongoose from "mongoose";
import Quote from "../models/Quote.model";
import Load from "../models/Load.model";
import ShipmentReview from "../models/ShipmentReview.model";
import { findQuoteFollower, type ShipmentFollower } from "./shipmentFollower";
import { loadDispatchers, LOAD_CHAT_NOT_FOUND, type ChatLoad } from "./shipmentChat.service";
import { SHIPMENT_NOT_FOUND } from "./customerShipmentTracking";
import { emitToUser } from "../utils/socketEmitter";
import { safeCreateNotification } from "../utils/safeNotification";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";

/*
 * "Confirm received" and the customer's review of a delivered shipment
 * (decided 2026-11-05):
 * - the customer who follows the shipment confirms they received the
 *   vehicle, which closes both shipment chats;
 * - one review per load, never edited: the driver gets 1–5 stars and
 *   optional words, the dealership optional words (no dealership stars);
 * - the driver's star average is shown to dealerships in Driver Tracker,
 *   the words only to the load's own dealership; the driver sees nothing.
 */

export const MAX_DRIVER_COMMENT = 1000;
export const MAX_DEALERSHIP_COMMENT = 2000;

const LOAD_FIELDS = "_id organizationId quoteId loadNumber status assignedDriverId dispatchOwnerId createdBy deliveredAt";
const QUOTE_FIELDS = "_id organizationId source requestedBy email portalShareOff vehicleName";

export interface ReviewInput {
  driverStars: number | null;
  driverComment: string;
  dealershipComment: string;
}

/**
 * Checks a review from the customer. `hasDriver` is false when staff marked
 * the load delivered without a driver: then there's no driver to rate.
 * Returns the cleaned review, or throws what to fix in plain English.
 */
export function parseReview(body: unknown, hasDriver: boolean): ReviewInput {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const driverComment = hasDriver ? text(raw.driverComment) : "";
  const dealershipComment = text(raw.dealershipComment);

  let driverStars: number | null = null;
  if (hasDriver && raw.driverStars !== undefined && raw.driverStars !== null && raw.driverStars !== "") {
    const stars = Number(raw.driverStars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      throw new ApiError(400, "Choose 1 to 5 stars for your driver.");
    }
    driverStars = stars;
  }

  if (driverComment && driverStars === null) throw new ApiError(400, "Choose 1 to 5 stars for your driver, then send your review.");
  if (driverComment.length > MAX_DRIVER_COMMENT) {
    throw new ApiError(400, `What you wrote about your driver can be up to ${MAX_DRIVER_COMMENT.toLocaleString("en-US")} characters. Shorten it and try again.`);
  }
  if (dealershipComment.length > MAX_DEALERSHIP_COMMENT) {
    throw new ApiError(400, `What you wrote for the dealership can be up to ${MAX_DEALERSHIP_COMMENT.toLocaleString("en-US")} characters. Shorten it and try again.`);
  }
  if (driverStars === null && !dealershipComment) {
    throw new ApiError(
      400,
      hasDriver
        ? "Choose stars for your driver or write a few words for the dealership, then send your review."
        : "Write a few words for the dealership, then send your review.",
    );
  }
  return { driverStars, driverComment, dealershipComment };
}

/** True when the body carries anything that looks like a review. */
export function hasReviewFields(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const raw = body as Record<string, unknown>;
  return ["driverStars", "driverComment", "dealershipComment"].some((key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== "");
}

interface ReceiptContext {
  quote: { _id: mongoose.Types.ObjectId; organizationId: string; vehicleName?: string };
  customer: ShipmentFollower;
  load: ChatLoad;
}

/** One of the customer's own delivered shipments, worked out from the quote and its newest load. */
async function customerDeliveredShipment(customerId: string, quoteId: unknown): Promise<ReceiptContext> {
  const id = String(quoteId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(id) || !mongoose.Types.ObjectId.isValid(customerId)) throw new ApiError(404, SHIPMENT_NOT_FOUND);
  const quote = await Quote.findById(id).select(QUOTE_FIELDS).lean<ReceiptContext["quote"] & { source?: string }>();
  const customer = await findQuoteFollower(quote);
  if (!quote || !customer || customer.id !== customerId) throw new ApiError(404, SHIPMENT_NOT_FOUND);
  const load = await Load.findOne({ quoteId: id, organizationId: quote.organizationId })
    .sort({ createdAt: -1 })
    .select(LOAD_FIELDS)
    .lean<ChatLoad>();
  if (!load || load.status !== "Delivered") {
    throw new ApiError(409, "You can confirm once your vehicle is delivered. My Shipments shows each step as it happens.");
  }
  return { quote, customer, load };
}

/** Tells the load's dispatcher, and closes both chats on every open screen. Never throws. */
async function afterReceipt(ctx: ReceiptContext, event: "received" | "reviewed") {
  const { load, quote, customer } = ctx;
  const loadId = String(load._id);
  const quoteId = String(quote._id);
  try {
    const dispatcher = (await loadDispatchers([load])).get(loadId) ?? null;
    if (event === "received") {
      // Both chats close: refresh them wherever they're open.
      const people = [customer.id, String(load.assignedDriverId ?? ""), dispatcher?.id ?? ""].filter(Boolean);
      for (const userId of new Set(people)) {
        for (const kind of ["driver", "dispatcher"] as const) {
          emitToUser(userId, "shipment-chat:changed", { threadId: null, loadId, quoteId, kind });
        }
      }
    }
    if (!dispatcher) return;
    const vehicle = String(quote.vehicleName ?? "").trim() || "the vehicle";
    const who = customer.name || "The customer";
    await safeCreateNotification({
      userId: dispatcher.id,
      organizationId: String(load.organizationId),
      type: "shipment_status_changed",
      title: event === "received" ? "Vehicle received" : "New customer review",
      message:
        event === "received"
          ? `${who} confirmed they received the ${vehicle}${load.loadNumber ? ` (load ${load.loadNumber})` : ""}. Their chats on this load are now closed.`
          : `${who} reviewed the delivery of the ${vehicle}${load.loadNumber ? ` (load ${load.loadNumber})` : ""}. Open the load to read it.`,
      metadata: { route: `/transportation/load/${loadId}`, loadId, quoteId, loadNumber: load.loadNumber },
    });
  } catch (error) {
    logger.error({ error, loadId, event }, "[ShipmentReview] Non-fatal: follow-up after the customer's confirmation failed");
  }
}

const isDuplicate = (error: unknown) => (error as { code?: number })?.code === 11000;

export interface CustomerReceiptView {
  receivedAt: string;
  reviewed: boolean;
  /** The stars the customer gave their driver (they see their own review). */
  driverStars: number | null;
}

const receiptView = (record: { receivedAt: Date; reviewedAt?: Date | null; driverStars?: number | null }): CustomerReceiptView => ({
  receivedAt: new Date(record.receivedAt).toISOString(),
  reviewed: Boolean(record.reviewedAt),
  driverStars: record.driverStars ?? null,
});

/**
 * The customer confirms they received their delivered vehicle, optionally
 * with their review. Confirming twice is harmless.
 */
export async function confirmShipmentReceived(customerId: string, quoteId: unknown, body: unknown) {
  const ctx = await customerDeliveredShipment(customerId, quoteId);
  const hasDriver = Boolean(ctx.load.assignedDriverId);
  const review = hasReviewFields(body) ? parseReview(body, hasDriver) : null;
  const now = new Date();

  const existing = await ShipmentReview.findOne({ loadId: ctx.load._id }).lean();
  if (existing) {
    if (review && !existing.reviewedAt) return reviewShipment(customerId, quoteId, body);
    return { receipt: receiptView(existing), alreadyConfirmed: true };
  }

  try {
    const created = await ShipmentReview.create({
      organizationId: String(ctx.load.organizationId),
      loadId: ctx.load._id,
      quoteId: ctx.quote._id,
      customerId: new mongoose.Types.ObjectId(customerId),
      driverId: ctx.load.assignedDriverId ?? null,
      receivedAt: now,
      ...(review ? { ...review, reviewedAt: now } : {}),
    });
    void afterReceipt(ctx, "received");
    if (review) void afterReceipt(ctx, "reviewed");
    return { receipt: receiptView(created), alreadyConfirmed: false };
  } catch (error) {
    // Confirmed from two screens at once: the first one counts.
    if (!isDuplicate(error)) throw error;
    const winner = await ShipmentReview.findOne({ loadId: ctx.load._id }).lean();
    if (!winner) throw error;
    return { receipt: receiptView(winner), alreadyConfirmed: true };
  }
}

/**
 * The customer's one review of a delivered shipment. It also confirms
 * receipt if they hadn't yet. Reviews can't be changed once sent.
 */
export async function reviewShipment(customerId: string, quoteId: unknown, body: unknown) {
  const ctx = await customerDeliveredShipment(customerId, quoteId);
  const review = parseReview(body, Boolean(ctx.load.assignedDriverId));
  const now = new Date();

  const existing = await ShipmentReview.findOne({ loadId: ctx.load._id }).lean();
  if (existing?.reviewedAt) throw new ApiError(409, "You've already reviewed this delivery. Reviews can't be changed once they're sent.");

  if (!existing) {
    try {
      const created = await ShipmentReview.create({
        organizationId: String(ctx.load.organizationId),
        loadId: ctx.load._id,
        quoteId: ctx.quote._id,
        customerId: new mongoose.Types.ObjectId(customerId),
        driverId: ctx.load.assignedDriverId ?? null,
        receivedAt: now,
        ...review,
        reviewedAt: now,
      });
      void afterReceipt(ctx, "received");
      void afterReceipt(ctx, "reviewed");
      return { receipt: receiptView(created), alreadyConfirmed: false };
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      // Confirmed from another screen meanwhile: add the review to it below.
    }
  }

  // Only a confirmation without a review yet can take the review.
  const updated = await ShipmentReview.findOneAndUpdate(
    { loadId: ctx.load._id, reviewedAt: null },
    { $set: { ...review, reviewedAt: now } },
    { new: true },
  ).lean();
  if (!updated) throw new ApiError(409, "You've already reviewed this delivery. Reviews can't be changed once they're sent.");
  void afterReceipt(ctx, "reviewed");
  return { receipt: receiptView(updated), alreadyConfirmed: true };
}

/** For My Shipments: each load's confirmation and whether it was reviewed. One query. */
export async function receiptsForLoads(loadIds: unknown[]): Promise<Map<string, CustomerReceiptView>> {
  const ids = loadIds.map((id) => String(id ?? "")).filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) return new Map();
  const rows = await ShipmentReview.find({ loadId: { $in: ids } })
    .select("loadId receivedAt reviewedAt driverStars")
    .lean<Array<{ loadId: unknown; receivedAt: Date; reviewedAt?: Date | null; driverStars?: number | null }>>();
  return new Map(rows.map((row) => [String(row.loadId), receiptView(row)]));
}

export interface StaffReviewView {
  customerName: string;
  receivedAt: string;
  reviewedAt: string | null;
  driverStars: number | null;
  driverComment: string;
  dealershipComment: string;
}

/**
 * What the load's own dealership sees: when the customer confirmed, and
 * their review. Drivers never reach this; other dealerships get "not found".
 */
export async function loadCustomerReview(actor: { role?: string }, organizationId: unknown, loadId: unknown): Promise<StaffReviewView | null> {
  if (!["employee", "admin", "super_admin"].includes(String(actor.role ?? ""))) {
    throw new ApiError(403, "Customer reviews are for the dealership's staff.");
  }
  const id = String(loadId ?? "").trim();
  const orgId = String(organizationId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(id) || !orgId) throw new ApiError(404, LOAD_CHAT_NOT_FOUND);
  const load = await Load.findOne({ _id: id, organizationId: orgId }).select("_id").lean();
  if (!load) throw new ApiError(404, LOAD_CHAT_NOT_FOUND);

  const record = await ShipmentReview.findOne({ loadId: id, organizationId: orgId })
    .populate("customerId", "name")
    .lean<{ customerId?: { name?: string } | null; receivedAt: Date; reviewedAt?: Date | null; driverStars?: number | null; driverComment?: string; dealershipComment?: string }>();
  if (!record) return null;
  return {
    customerName: String(record.customerId?.name ?? "").trim() || "Customer",
    receivedAt: new Date(record.receivedAt).toISOString(),
    reviewedAt: record.reviewedAt ? new Date(record.reviewedAt).toISOString() : null,
    driverStars: record.driverStars ?? null,
    driverComment: record.driverComment ?? "",
    dealershipComment: record.dealershipComment ?? "",
  };
}

export interface DriverCustomerRating {
  /** Average stars, rounded to one decimal. */
  average: number;
  count: number;
}

/** Customers' star average for each driver (Driver Tracker). One query. */
export async function driverCustomerRatings(driverIds: unknown[]): Promise<Map<string, DriverCustomerRating>> {
  const ids = [...new Set(driverIds.map((id) => String(id ?? "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  if (ids.length === 0) return new Map();
  const rows = await ShipmentReview.aggregate<{ _id: mongoose.Types.ObjectId; average: number; count: number }>([
    { $match: { driverId: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) }, driverStars: { $gte: 1 } } },
    { $group: { _id: "$driverId", average: { $avg: "$driverStars" }, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), { average: Math.round(row.average * 10) / 10, count: row.count }]));
}
