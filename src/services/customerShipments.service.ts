import mongoose from "mongoose";
import Quote from "../models/Quote.model";
import Load from "../models/Load.model";
import Organization from "../models/Organization.model";
import notificationService from "./notification.service";
import logger from "../utils/logger";
import { LOAD_CANCELLATION_REASON_LABELS, isLoadCancellationReason } from "../constants/loadCancellation";

/*
 * What a customer sees about the shipping requests they sent from the
 * customer portal: the "My Shipments" list and the notifications that follow
 * a request (answered, booked, on the way, delivered or cancelled, or closed
 * because the vehicle left the marketplace). Customers never see the
 * dealership's internal notes, the driver, or the driver's location.
 */

/** The customer portal page these notifications open. */
export const CUSTOMER_SHIPMENTS_ROUTE = "/customer/shipments";

export type CustomerShipmentEvent =
  | "accepted"
  | "declined"
  | "unavailable"
  | "booked"
  | "on_the_way"
  | "delivered"
  | "cancelled"
  | "closed";

export interface CustomerShipmentContext {
  vehicleName?: string;
  dealerName?: string;
  loadNumber?: string;
  /** The cancellation reason's label, never the staff note. */
  reasonLabel?: string;
  /** The reason staff wrote when declining, meant for the customer. */
  declineReason?: string;
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The notification a customer gets for one step of their shipment. */
export function customerShipmentNotice(
  event: CustomerShipmentEvent,
  ctx: CustomerShipmentContext = {},
): { type: string; title: string; message: string } {
  const name = String(ctx.vehicleName ?? "").trim();
  const theVehicle = name ? `the ${name}` : "the vehicle";
  const yourVehicle = name ? `your ${name}` : "your vehicle";
  const dealer = String(ctx.dealerName ?? "").trim() || "The dealership";
  const follow = "You can follow it in My Shipments.";
  switch (event) {
    case "accepted":
      return {
        type: "quote_accepted",
        title: "Shipping Request Accepted",
        message: `${dealer} accepted your shipping request for ${theVehicle}. They'll contact you to arrange the details.`,
      };
    case "declined": {
      // Drop a trailing period so the sentence doesn't end with "..".
      const reason = String(ctx.declineReason ?? "").trim().replace(/[.\s]+$/, "");
      return {
        type: "shipment_status_changed",
        title: "Shipping Request Declined",
        message: `${dealer} declined your shipping request for ${theVehicle}${reason ? `. Reason: ${reason}` : ""}. Contact them if you have questions.`,
      };
    }
    case "unavailable":
      return {
        type: "shipment_status_changed",
        title: "Vehicle No Longer Available",
        message: `${capitalize(theVehicle)} is no longer available, so your shipping request was closed.`,
      };
    case "booked":
      return {
        type: "shipment_created",
        title: "Shipment Booked",
        message: `${dealer} booked the shipment for ${yourVehicle}${ctx.loadNumber ? ` (shipment ${ctx.loadNumber})` : ""}. ${follow}`,
      };
    case "on_the_way":
      return {
        type: "shipment_picked_up",
        title: "Your Vehicle Is on Its Way",
        message: `${capitalize(yourVehicle)} was picked up and is on its way to you. ${follow}`,
      };
    case "delivered":
      return {
        type: "shipment_delivered",
        title: "Vehicle Delivered",
        message: `${capitalize(yourVehicle)} was delivered.`,
      };
    case "cancelled":
      return {
        type: "shipment_status_changed",
        title: "Shipment Cancelled",
        message: `${dealer} cancelled the shipment for ${yourVehicle}${
          ctx.reasonLabel ? `. Reason: ${ctx.reasonLabel}` : ""
        }. Contact them if you have questions.`,
      };
    case "closed":
      return {
        type: "shipment_status_changed",
        title: "Shipping Request Closed",
        message: `${dealer} closed your shipping request for ${theVehicle}. Contact them if you have questions.`,
      };
  }
}

export interface QuoteCustomer {
  customerId: string;
  quoteId: string;
  vehicleName?: string;
  dealerName?: string;
}

/**
 * The customer who sent this quote from the customer portal, with what their
 * notifications name. Null for staff quotes and anything that doesn't match.
 */
export async function findQuoteCustomer(organizationId: string, quoteId: unknown): Promise<QuoteCustomer | null> {
  const id = String(quoteId ?? "").trim();
  if (!organizationId || !mongoose.Types.ObjectId.isValid(id)) return null;
  const quote = await Quote.findOne({ _id: id, organizationId, source: "customer_portal" })
    .select("requestedBy vehicleName")
    .lean<{ requestedBy?: mongoose.Types.ObjectId; vehicleName?: string }>();
  if (!quote?.requestedBy) return null;
  const org = mongoose.Types.ObjectId.isValid(organizationId)
    ? await Organization.findById(organizationId).select("name").lean<{ name?: string }>()
    : null;
  return {
    customerId: String(quote.requestedBy),
    quoteId: id,
    vehicleName: quote.vehicleName,
    dealerName: org?.name,
  };
}

/** Notification body for a customer, ready for the lifecycle outbox or a direct send. */
export function customerShipmentNotification(
  customer: QuoteCustomer,
  organizationId: string,
  event: CustomerShipmentEvent,
  extra: Pick<CustomerShipmentContext, "loadNumber" | "reasonLabel" | "declineReason"> = {},
) {
  const notice = customerShipmentNotice(event, { ...customer, ...extra });
  return {
    userId: customer.customerId,
    organizationId,
    type: notice.type,
    title: notice.title,
    message: notice.message,
    metadata: {
      quoteId: customer.quoteId,
      ...(extra.loadNumber ? { loadNumber: extra.loadNumber } : {}),
      route: CUSTOMER_SHIPMENTS_ROUTE,
    },
  };
}

/**
 * Tells the customer behind a quote about a step, right away. Never throws:
 * the dealership's own action has already succeeded.
 */
export async function notifyQuoteCustomer(
  organizationId: string,
  quoteId: unknown,
  event: CustomerShipmentEvent,
  extra: Pick<CustomerShipmentContext, "loadNumber" | "reasonLabel" | "declineReason"> = {},
): Promise<boolean> {
  try {
    const customer = await findQuoteCustomer(organizationId, quoteId);
    if (!customer) return false;
    await notificationService.createNotification(customerShipmentNotification(customer, organizationId, event, extra) as any);
    return true;
  } catch (err) {
    logger.error({ err, organizationId, quoteId: String(quoteId ?? ""), event }, "Non-fatal: failed to notify the customer about their shipment");
    return false;
  }
}

/**
 * Tells the customer their request was closed after staff deleted it. The
 * quote is already gone, so the customer comes from the deleted record.
 * Never throws.
 */
export async function notifyCustomerOfDeletedRequest(
  organizationId: string,
  deleted: { _id: unknown; requestedBy?: unknown; vehicleName?: string },
): Promise<boolean> {
  try {
    const customerId = String(deleted.requestedBy ?? "").trim();
    if (!mongoose.Types.ObjectId.isValid(customerId)) return false;
    const org = mongoose.Types.ObjectId.isValid(organizationId)
      ? await Organization.findById(organizationId).select("name").lean<{ name?: string }>()
      : null;
    const customer: QuoteCustomer = {
      customerId,
      quoteId: String(deleted._id),
      vehicleName: deleted.vehicleName,
      dealerName: org?.name,
    };
    await notificationService.createNotification(customerShipmentNotification(customer, organizationId, "closed") as any);
    return true;
  } catch (err) {
    logger.error({ err, organizationId, quoteId: String(deleted?._id ?? "") }, "Non-fatal: failed to tell the customer their request was closed");
    return false;
  }
}

/** The cancellation reason's label for customers (never the staff note). */
export function customerCancellationReason(reason: unknown): string | undefined {
  return isLoadCancellationReason(reason) ? LOAD_CANCELLATION_REASON_LABELS[reason] : undefined;
}

export type CustomerShipmentStage =
  | "waiting"
  | "accepted"
  | "declined"
  | "unavailable"
  | "booked"
  | "picked_up"
  | "on_the_way"
  | "delivered"
  | "cancelled";

/** Where a customer's request stands, from the quote and its newest load. */
export function customerShipmentStage(
  quote: { status?: string; closedReason?: string | null },
  load?: { status?: string } | null,
): CustomerShipmentStage {
  if (load) {
    switch (load.status) {
      case "Picked Up":
        return "picked_up";
      case "In-Transit":
        return "on_the_way";
      case "Delivered":
        return "delivered";
      case "Cancelled":
        return "cancelled";
      default:
        return "booked";
    }
  }
  if (quote.status === "rejected") return quote.closedReason === "vehicle_unavailable" ? "unavailable" : "declined";
  if (quote.status === "accepted") return "accepted";
  if (quote.status === "booked") return "booked";
  return "waiting";
}

const isoOrNull = (value: unknown) => {
  if (!value) return null;
  const time = new Date(value as string | Date).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

/** The stages where the customer sees when to expect the car. */
const EXPECTED_BY_STAGES = new Set<CustomerShipmentStage>(["booked", "picked_up", "on_the_way"]);

/** The customer's own shipping requests, newest first, for "My Shipments". */
export async function listCustomerShipments(customerId: string, limit = 50) {
  const quotes = await Quote.find({ requestedBy: customerId, source: "customer_portal" })
    .select("_id organizationId vehicleName vehicleImage toAddress miles rate eta status closedReason declineReason createdAt")
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<any[]>();
  if (quotes.length === 0) return [];

  const quoteIds = quotes.map((quote) => quote._id);
  const orgIds = [...new Set(quotes.map((quote) => String(quote.organizationId ?? "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const [loads, orgs] = await Promise.all([
    Load.find({ quoteId: { $in: quoteIds } })
      .select("quoteId organizationId loadNumber status createdAt pickedUpAt inTransitAt deliveredAt cancellation.reason cancellation.at dates.deliveryDeadline")
      .sort({ createdAt: -1 })
      .lean<any[]>(),
    orgIds.length ? Organization.find({ _id: { $in: orgIds } }).select("name").lean<any[]>() : Promise.resolve([]),
  ]);

  const dealerById = new Map(orgs.map((org) => [String(org._id), String(org.name ?? "").trim()]));
  // The newest load per quote, and only from the quote's own dealership.
  const loadByQuote = new Map<string, any>();
  const orgByQuote = new Map(quotes.map((quote) => [String(quote._id), String(quote.organizationId ?? "")]));
  for (const load of loads) {
    const quoteId = String(load.quoteId);
    if (loadByQuote.has(quoteId) || String(load.organizationId ?? "") !== orgByQuote.get(quoteId)) continue;
    loadByQuote.set(quoteId, load);
  }

  return quotes.map((quote) => {
    const load = loadByQuote.get(String(quote._id)) ?? null;
    const stage = customerShipmentStage(quote, load);
    return {
      id: String(quote._id),
      vehicleName: quote.vehicleName ?? "",
      vehicleImage: quote.vehicleImage ?? null,
      dealerName: dealerById.get(String(quote.organizationId ?? "")) || "",
      deliveryAddress: quote.toAddress ?? "",
      miles: quote.miles ?? null,
      rate: quote.rate ?? null,
      eta: quote.eta ?? null,
      requestedAt: isoOrNull(quote.createdAt),
      stage,
      // What staff wrote for the customer when declining (optional).
      declineReason: stage === "declined" ? String(quote.declineReason ?? "").trim() || null : null,
      shipment: load
        ? {
            number: String(load.loadNumber ?? ""),
            bookedAt: isoOrNull(load.createdAt),
            pickedUpAt: isoOrNull(load.pickedUpAt),
            onTheWayAt: isoOrNull(load.inTransitAt),
            deliveredAt: isoOrNull(load.deliveredAt),
            cancelledAt: load.status === "Cancelled" ? isoOrNull(load.cancellation?.at) : null,
            cancelReason: load.status === "Cancelled" ? customerCancellationReason(load.cancellation?.reason) ?? null : null,
            // The load's delivery deadline (decided 2026-10-29), only while the
            // shipment is still coming; never after delivery or cancellation.
            expectedBy: EXPECTED_BY_STAGES.has(stage) ? isoOrNull(load.dates?.deliveryDeadline) : null,
          }
        : null,
    };
  });
}
