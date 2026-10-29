import mongoose from "mongoose";
import Quote from "../models/Quote.model";
import Lead from "../models/lead.model";
import User from "../models/User.model";
import notificationService from "./notification.service";
import logger from "../utils/logger";

/*
 * The salesperson assigned to the CRM lead linked to a quote hears about
 * their customer's shipment (decided 2026-10-29): a new request from the
 * customer portal, and the shipment delivered or cancelled. Only an active
 * staff member of the quote's own dealership is told, never the person who
 * took the step, and never twice when they already get the dealership-wide
 * notice for it.
 */

export type SalespersonEvent = "request" | "delivered" | "cancelled";

export interface SalespersonContext {
  customerName?: string;
  vehicleName?: string;
  loadNumber?: string;
  /** The cancellation reason as staff see it (the label, then any note). */
  reason?: string;
}

const STAFF_ROLES = ["employee", "admin", "super_admin"];
const ADMIN_ROLES = ["admin", "super_admin"];

/** The notice a salesperson gets for one step of their customer's shipment. */
export function salespersonNotice(
  event: SalespersonEvent,
  ctx: SalespersonContext = {},
): { type: string; title: string; message: string } {
  const customer = String(ctx.customerName ?? "").trim() || "Your customer";
  const vehicle = String(ctx.vehicleName ?? "").trim();
  const theVehicle = vehicle ? `the ${vehicle}` : "their vehicle";
  const load = ctx.loadNumber ? ` (load ${ctx.loadNumber})` : "";
  switch (event) {
    case "request":
      return {
        type: "quote_created",
        title: "Your Customer Sent a Shipping Request",
        message: `${customer} asked for a shipping quote for ${theVehicle} from the customer portal. You'll find it under Quotes in Transportation.`,
      };
    case "delivered":
      return {
        type: "load_delivered",
        title: "Your Customer's Vehicle Was Delivered",
        message: `${customer}'s shipment for ${theVehicle}${load} was delivered.`,
      };
    case "cancelled": {
      const reason = String(ctx.reason ?? "").trim().replace(/[.\s]+$/, "");
      return {
        // The type the dispatcher's "Load Cancelled" notice uses.
        type: "general",
        title: "Your Customer's Shipment Was Cancelled",
        message: `${customer}'s shipment for ${theVehicle}${load} was cancelled${reason ? `. Reason: ${reason}` : ""}.`,
      };
    }
  }
}

export interface QuoteSalesperson {
  userId: string;
  quoteId: string;
  customerName?: string;
  vehicleName?: string;
}

export interface SalespersonOptions {
  /** Whoever took the step, and anyone already told about it directly. */
  excludeUserIds?: Array<string | null | undefined>;
  /** True when the dealership's admins already get a notice for this step. */
  skipAdmins?: boolean;
}

/**
 * The salesperson to tell about this quote, or null: the quote has no linked
 * lead, the lead has no one assigned, that person isn't active staff of this
 * dealership, or the options leave them out.
 */
export async function findQuoteSalesperson(
  organizationId: string,
  quoteId: unknown,
  options: SalespersonOptions = {},
): Promise<QuoteSalesperson | null> {
  const id = String(quoteId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(organizationId) || !mongoose.Types.ObjectId.isValid(id)) return null;

  const quote = await Quote.findOne({ _id: id, organizationId })
    .select("leadId firstName lastName vehicleName")
    .lean<{ leadId?: mongoose.Types.ObjectId | null; firstName?: string; lastName?: string; vehicleName?: string }>();
  if (!quote?.leadId) return null;

  const lead = await Lead.findOne({ _id: quote.leadId, organizationId: new mongoose.Types.ObjectId(organizationId) })
    .select("assignedTo")
    .lean<{ assignedTo?: mongoose.Types.ObjectId | null }>();
  const assignedTo = String(lead?.assignedTo ?? "");
  if (!mongoose.Types.ObjectId.isValid(assignedTo)) return null;
  if ((options.excludeUserIds ?? []).some((userId) => String(userId ?? "") === assignedTo)) return null;

  const user = await User.findOne({
    _id: assignedTo,
    organizationId,
    isActive: true,
    role: { $in: STAFF_ROLES },
  })
    .select("role organizationRole")
    .lean<{ role?: string; organizationRole?: string }>();
  if (!user) return null;
  if (
    options.skipAdmins &&
    (ADMIN_ROLES.includes(String(user.role ?? "")) || ADMIN_ROLES.includes(String(user.organizationRole ?? "")))
  ) {
    return null;
  }

  const customerName = [quote.firstName, quote.lastName].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ");
  return {
    userId: assignedTo,
    quoteId: id,
    customerName: customerName || undefined,
    vehicleName: quote.vehicleName,
  };
}

/** Notification body for a salesperson, ready for the lifecycle outbox or a direct send. */
export function salespersonNotification(
  salesperson: QuoteSalesperson,
  organizationId: string,
  event: SalespersonEvent,
  extra: { loadId?: string; loadNumber?: string; reason?: string } = {},
) {
  const notice = salespersonNotice(event, { ...salesperson, ...extra });
  return {
    userId: salesperson.userId,
    organizationId,
    type: notice.type,
    title: notice.title,
    message: notice.message,
    metadata: {
      quoteId: salesperson.quoteId,
      ...(extra.loadId ? { loadId: extra.loadId } : {}),
      ...(extra.loadNumber ? { loadNumber: extra.loadNumber } : {}),
      route: extra.loadId
        ? `/transportation/load/${encodeURIComponent(extra.loadId)}`
        : "/transportation?tab=drafts",
    },
  };
}

/**
 * Tells the salesperson about a new customer request, right away. Never
 * throws: the customer's request has already been saved.
 */
export async function notifyQuoteSalesperson(
  organizationId: string,
  quoteId: unknown,
  options: SalespersonOptions = {},
): Promise<boolean> {
  try {
    const salesperson = await findQuoteSalesperson(organizationId, quoteId, options);
    if (!salesperson) return false;
    await notificationService.createNotification(salespersonNotification(salesperson, organizationId, "request") as any);
    return true;
  } catch (err) {
    logger.error({ err, organizationId, quoteId: String(quoteId ?? "") }, "Non-fatal: failed to tell the salesperson about their customer's request");
    return false;
  }
}
