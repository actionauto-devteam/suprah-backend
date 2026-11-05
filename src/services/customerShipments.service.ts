import mongoose from "mongoose";
import Quote from "../models/Quote.model";
import Load from "../models/Load.model";
import Organization from "../models/Organization.model";
import User from "../models/User.model";
import DriverProfile from "../models/DriverProfile.model";
import notificationService from "./notification.service";
import { findQuoteFollower, type ShipmentFollower } from "./shipmentFollower";
import logger from "../utils/logger";
import { LOAD_CANCELLATION_REASON_LABELS, isLoadCancellationReason } from "../constants/loadCancellation";

/*
 * What a customer sees about their shipments in the customer portal: the
 * "My Shipments" list and a notification at every step. A shipment is one the
 * customer asked for from the portal, or a staff-made quote whose email is
 * their verified account email (see shipmentFollower.ts).
 *
 * Steps (decided 2026-11-05): requested, booked, driver accepted, picked up,
 * on the way, arrived, delivered, plus "finding a new driver" when a driver
 * who had accepted hands the load back. Once a driver accepts, the customer
 * sees that driver's full name, photo and truck, never their phone, email or
 * anything from the dealership's internal notes.
 */

/** The customer portal page these notifications open. */
export const CUSTOMER_SHIPMENTS_ROUTE = "/customer/shipments";

export type CustomerShipmentEvent =
  | "accepted"
  | "declined"
  | "unavailable"
  | "booked"
  | "driver_accepted"
  | "picked_up"
  | "on_the_way"
  | "arrived"
  | "delivered"
  | "finding_driver"
  | "cancelled"
  | "closed";

/**
 * Answers about a request the customer sent themselves. A customer following
 * a staff-made quote never asked for it, so they only hear about the shipment.
 */
const REQUEST_ONLY_EVENTS = new Set<CustomerShipmentEvent>(["accepted", "declined", "unavailable", "closed"]);

export interface CustomerShipmentContext {
  vehicleName?: string;
  dealerName?: string;
  loadNumber?: string;
  /** The driver's full name (driver accepted, picked up). */
  driverName?: string;
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
  const driver = String(ctx.driverName ?? "").replace(/\s+/g, " ").trim();
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
    case "driver_accepted":
      return {
        type: "shipment_assigned",
        title: "Driver Accepted Your Shipment",
        message: `${driver || "A driver"} accepted the shipment for ${yourVehicle}. You can see your driver and follow each step in My Shipments.`,
      };
    case "picked_up":
      return {
        type: "shipment_picked_up",
        title: "Vehicle Picked Up",
        message: `${capitalize(yourVehicle)} was picked up${driver ? ` by ${driver}` : ""}. ${follow}`,
      };
    case "on_the_way":
      return {
        type: "shipment_status_changed",
        title: "Your Vehicle Is on Its Way",
        message: `${capitalize(yourVehicle)} is on its way to you. ${follow}`,
      };
    case "arrived":
      return {
        type: "shipment_arrived_at_delivery",
        title: "Driver Arrived",
        message: `Your driver arrived at the delivery address with ${yourVehicle}.`,
      };
    case "delivered":
      return {
        type: "shipment_delivered",
        title: "Vehicle Delivered",
        message: `${capitalize(yourVehicle)} was delivered. If something isn't right, contact ${dealer === "The dealership" ? "the dealership" : dealer}.`,
      };
    case "finding_driver":
      return {
        type: "shipment_status_changed",
        title: "Finding a New Driver",
        message: `The driver for ${yourVehicle} can no longer take it, so ${dealer === "The dealership" ? "the dealership" : dealer} is finding a new driver. We'll let you know when one accepts.`,
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
  /** "request": they asked from the portal. "shared": a staff quote with their email. */
  kind?: ShipmentFollower["kind"];
}

/** Whether this customer hears about this event (see REQUEST_ONLY_EVENTS). */
export function customerHearsEvent(customer: Pick<QuoteCustomer, "kind">, event: CustomerShipmentEvent): boolean {
  return customer.kind !== "shared" || !REQUEST_ONLY_EVENTS.has(event);
}

/**
 * The customer who follows this quote's shipment in their portal (they asked
 * for it, or it's a staff quote with their verified email), with what their
 * notifications name. Null when nobody follows it.
 */
export async function findQuoteCustomer(organizationId: string, quoteId: unknown): Promise<QuoteCustomer | null> {
  const id = String(quoteId ?? "").trim();
  if (!organizationId || !mongoose.Types.ObjectId.isValid(id)) return null;
  const quote = await Quote.findOne({ _id: id, organizationId })
    .select("source requestedBy email portalShareOff vehicleName")
    .lean<{ source?: string; requestedBy?: mongoose.Types.ObjectId; email?: string; portalShareOff?: boolean; vehicleName?: string }>();
  const follower = await findQuoteFollower(quote);
  if (!quote || !follower) return null;
  const org = mongoose.Types.ObjectId.isValid(organizationId)
    ? await Organization.findById(organizationId).select("name").lean<{ name?: string }>()
    : null;
  return {
    customerId: follower.id,
    quoteId: id,
    vehicleName: quote.vehicleName,
    dealerName: org?.name,
    kind: follower.kind,
  };
}

/** Notification body for a customer, ready for the lifecycle outbox or a direct send. */
export function customerShipmentNotification(
  customer: QuoteCustomer,
  organizationId: string,
  event: CustomerShipmentEvent,
  extra: Pick<CustomerShipmentContext, "loadNumber" | "reasonLabel" | "declineReason" | "driverName"> = {},
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
  extra: Pick<CustomerShipmentContext, "loadNumber" | "reasonLabel" | "declineReason" | "driverName"> = {},
): Promise<boolean> {
  try {
    const customer = await findQuoteCustomer(organizationId, quoteId);
    if (!customer || !customerHearsEvent(customer, event)) return false;
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
  | "withdrawn"
  | "booked"
  | "finding_driver"
  | "driver_accepted"
  | "picked_up"
  | "on_the_way"
  | "arrived"
  | "delivered"
  | "cancelled";

export interface StageLoad {
  status?: string;
  assignedDriverId?: unknown;
  arrivals?: { delivery?: { at?: unknown; driverId?: unknown } | null } | null;
  assignmentHistory?: Array<{ acceptedAt?: unknown; endReason?: unknown }> | null;
}

/** A driver who had accepted this load handed it back (dropped, removed, released or reassigned). */
export function driverHandedBack(load: Pick<StageLoad, "assignmentHistory">): boolean {
  return (load.assignmentHistory ?? []).some((entry) => Boolean(entry?.acceptedAt) && entry?.endReason !== "cancelled");
}

/** The current driver tapped "I've arrived" at the delivery address. */
export function arrivedAtDelivery(load: Pick<StageLoad, "arrivals" | "assignedDriverId">): boolean {
  const arrival = load.arrivals?.delivery;
  if (!arrival?.at) return false;
  // An arrival by a driver who has since handed the load back doesn't count.
  return !arrival.driverId || !load.assignedDriverId || String(arrival.driverId) === String(load.assignedDriverId);
}

/** Where a customer's shipment stands, from the quote and its newest load. */
export function customerShipmentStage(
  quote: { status?: string; closedReason?: string | null },
  load?: StageLoad | null,
): CustomerShipmentStage {
  if (load) {
    switch (load.status) {
      case "Accepted":
        return "driver_accepted";
      case "Picked Up":
        return arrivedAtDelivery(load) ? "arrived" : "picked_up";
      case "In-Transit":
        return arrivedAtDelivery(load) ? "arrived" : "on_the_way";
      case "Delivered":
        return "delivered";
      case "Cancelled":
        return "cancelled";
      default:
        // Draft, Posted or Assigned: waiting for a driver to accept.
        return driverHandedBack(load) ? "finding_driver" : "booked";
    }
  }
  if (quote.status === "rejected") {
    if (quote.closedReason === "vehicle_unavailable") return "unavailable";
    if (quote.closedReason === "customer_withdrew") return "withdrawn";
    return "declined";
  }
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
const EXPECTED_BY_STAGES = new Set<CustomerShipmentStage>([
  "booked",
  "finding_driver",
  "driver_accepted",
  "picked_up",
  "on_the_way",
  "arrived",
]);

/** The stages where the customer sees who is driving their car. */
const DRIVER_STAGES = new Set<CustomerShipmentStage>(["driver_accepted", "picked_up", "on_the_way", "arrived", "delivered"]);

export interface CustomerShipmentDriver {
  name: string;
  photoUrl: string | null;
  /** e.g. "2019 Peterbilt 389 · White"; null when the driver hasn't added it. */
  truck: string | null;
}

/** "2019 Peterbilt 389 · White" from the driver's Equipment page, or null. */
export function truckLabel(profile: { truckYear?: unknown; truckMake?: unknown; truckModel?: unknown; truckColor?: unknown } | null | undefined): string | null {
  if (!profile) return null;
  const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();
  const name = [clean(profile.truckYear), clean(profile.truckMake), clean(profile.truckModel)].filter(Boolean).join(" ");
  const color = clean(profile.truckColor);
  const label = [name, color].filter(Boolean).join(" · ");
  return label || null;
}

/**
 * The driver's profile photo as the website loads it (resolveImageUrl sends
 * stored and legacy photos through the backend). Anything else isn't sent.
 */
export function customerSafePhoto(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^https:\/\/\S+$/i.test(value)) return value;
  if (/^db:[a-f\d]{24}(\?[^\s#]*)?$/i.test(value)) return value;
  if (/^avatars\/\d{13}-\d{1,10}\.(jpe?g|png|webp|gif)$/i.test(value)) return value;
  return null;
}

/** What customers see about each driver: full name, photo and truck. Two queries. */
async function driversForCustomers(driverIds: string[]): Promise<Map<string, CustomerShipmentDriver>> {
  const ids = [...new Set(driverIds)].filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (ids.length === 0) return new Map();
  const [users, profiles] = await Promise.all([
    User.find({ _id: { $in: ids } }).select("name avatar").lean<any[]>(),
    DriverProfile.find({ userId: { $in: ids } }).select("userId truckYear truckMake truckModel truckColor").lean<any[]>(),
  ]);
  const profileByUser = new Map(profiles.map((profile) => [String(profile.userId), profile]));
  return new Map(
    users.map((user): [string, CustomerShipmentDriver] => [
      String(user._id),
      {
        name: String(user.name ?? "").replace(/\s+/g, " ").trim() || "Your driver",
        photoUrl: customerSafePhoto(user.avatar),
        truck: truckLabel(profileByUser.get(String(user._id))),
      },
    ]),
  );
}

const QUOTE_FIELDS =
  "_id organizationId source vehicleName vehicleImage toAddress miles rate eta status closedReason declineReason createdAt";
const LOAD_FIELDS =
  "quoteId organizationId loadNumber status assignedDriverId createdAt acceptedAt pickedUpAt inTransitAt deliveredAt arrivals.delivery cancellation.reason cancellation.at dates.deliveryDeadline +assignmentHistory";

/**
 * The customer's shipments, newest first, for "My Shipments": the requests
 * they sent from the portal, and staff-made quotes with their verified email
 * once they're booked (unless staff unlinked them).
 */
export async function listCustomerShipments(customerId: string, limit = 50) {
  if (!mongoose.Types.ObjectId.isValid(customerId)) return [];
  const account = await User.findById(customerId).select("email role emailVerified isActive").lean<any>();
  const sharesStaffQuotes = Boolean(account && account.role === "customer" && account.emailVerified && account.isActive && account.email);

  const [requests, shared] = await Promise.all([
    Quote.find({ requestedBy: customerId, source: "customer_portal" }).select(QUOTE_FIELDS).sort({ createdAt: -1 }).limit(limit).lean<any[]>(),
    sharesStaffQuotes
      ? Quote.find({ email: String(account.email).toLowerCase(), source: { $ne: "customer_portal" }, portalShareOff: { $ne: true } })
          .select(QUOTE_FIELDS)
          .sort({ createdAt: -1 })
          .limit(limit)
          .lean<any[]>()
      : Promise.resolve([] as any[]),
  ]);
  const quotes = [...requests, ...shared];
  if (quotes.length === 0) return [];

  const quoteIds = quotes.map((quote) => quote._id);
  const orgIds = [...new Set(quotes.map((quote) => String(quote.organizationId ?? "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const [loads, orgs] = await Promise.all([
    Load.find({ quoteId: { $in: quoteIds } }).select(LOAD_FIELDS).sort({ createdAt: -1 }).lean<any[]>(),
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

  // A staff-made quote only shows once it's booked: the customer never asked
  // for it, so there's nothing for them to follow before that.
  const visible = quotes
    .filter((quote) => quote.source === "customer_portal" || loadByQuote.has(String(quote._id)))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);

  const stageByQuote = new Map(
    visible.map((quote) => [String(quote._id), customerShipmentStage(quote, loadByQuote.get(String(quote._id)) ?? null)]),
  );
  const driverIds = visible
    .map((quote) => {
      const load = loadByQuote.get(String(quote._id));
      return load && DRIVER_STAGES.has(stageByQuote.get(String(quote._id))!) ? String(load.assignedDriverId ?? "") : "";
    })
    .filter(Boolean);
  const drivers = await driversForCustomers(driverIds).catch((err) => {
    logger.warn({ err }, "Could not load the drivers for My Shipments");
    return new Map<string, CustomerShipmentDriver>();
  });

  return visible.map((quote) => {
    const load = loadByQuote.get(String(quote._id)) ?? null;
    const stage = stageByQuote.get(String(quote._id))!;
    const isRequest = quote.source === "customer_portal";
    const driver = load && DRIVER_STAGES.has(stage) ? drivers.get(String(load.assignedDriverId ?? "")) ?? null : null;
    return {
      id: String(quote._id),
      // "request": they asked from the portal. "shared": the dealership booked it for them.
      kind: isRequest ? ("request" as const) : ("shared" as const),
      vehicleName: quote.vehicleName ?? "",
      vehicleImage: quote.vehicleImage ?? null,
      dealerName: dealerById.get(String(quote.organizationId ?? "")) || "",
      deliveryAddress: quote.toAddress ?? "",
      // The estimate is only shown on requests the customer asked for; a
      // staff quote's price is between the customer and the dealership.
      miles: isRequest ? quote.miles ?? null : null,
      rate: isRequest ? quote.rate ?? null : null,
      eta: isRequest ? quote.eta ?? null : null,
      requestedAt: isRequest ? isoOrNull(quote.createdAt) : null,
      stage,
      // What staff wrote for the customer when declining (optional).
      declineReason: stage === "declined" ? String(quote.declineReason ?? "").trim() || null : null,
      driver,
      shipment: load
        ? {
            number: String(load.loadNumber ?? ""),
            bookedAt: isoOrNull(load.createdAt),
            driverAcceptedAt: DRIVER_STAGES.has(stage) ? isoOrNull(load.acceptedAt) : null,
            pickedUpAt: isoOrNull(load.pickedUpAt),
            onTheWayAt: isoOrNull(load.inTransitAt),
            arrivedAt: stage === "arrived" || stage === "delivered" ? isoOrNull(arrivedAtDelivery(load) ? load.arrivals?.delivery?.at : null) : null,
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
