import mongoose from "mongoose";
import Quote from "../models/Quote.model";
import Organization from "../models/Organization.model";
import emailService from "./email.service";
import logger from "../utils/logger";
import config from "../config";
import { normalizeIdentityEmail } from "../utils/contactIdentity";
import { findQuoteFollower } from "./shipmentFollower";
import { CUSTOMER_SHIPMENTS_ROUTE } from "./customerShipments.service";

/*
 * Shipment updates by email. Sent through Suprah AI in the dealership's name
 * (from the dealership's own connected mailbox when it has one).
 *
 * - A customer who follows the shipment in their portal (they asked from the
 *   portal, or it's a staff quote with their verified email) gets an email at
 *   the key steps: a driver accepts, pickup and delivery (decided 2026-11-05).
 *   Every other step reaches them as a portal notification.
 * - The customer of a staff-made quote without a portal account keeps the
 *   emails from 2026-11-02: booked, on its way and delivered.
 *
 * Only the driver's name is ever included; never their phone, email or
 * location, nor anything from the dealership's internal notes.
 */

export type StaffQuoteEmailEvent = "booked" | "driver_accepted" | "picked_up" | "on_the_way" | "delivered";

/** The emails a customer who follows the shipment in their portal gets. */
export const FOLLOWER_EMAIL_EVENTS: ReadonlySet<StaffQuoteEmailEvent> = new Set(["driver_accepted", "picked_up", "delivered"]);
/** The emails the customer of a staff quote without a portal account gets. */
export const STAFF_QUOTE_EMAIL_EVENTS: ReadonlySet<StaffQuoteEmailEvent> = new Set(["booked", "on_the_way", "delivered"]);

export interface StaffQuoteEmailContext {
  customerFirstName?: unknown;
  vehicleName?: unknown;
  dealerName?: unknown;
  loadNumber?: unknown;
  driverName?: unknown;
  /** The My Shipments address, for customers who follow it in their portal. */
  shipmentsUrl?: unknown;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

/** A link to My Shipments on the Suprah AI site, or "" when the address isn't a web address. */
function safeShipmentsUrl(value: unknown): string {
  const url = clean(value);
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : "";
}

/** The email's subject, plain text and HTML for one step of the shipment. */
export function staffQuoteCustomerEmail(
  event: StaffQuoteEmailEvent,
  ctx: StaffQuoteEmailContext = {},
): { subject: string; text: string; html: string } {
  const name = clean(ctx.customerFirstName) || "there";
  const vehicle = clean(ctx.vehicleName);
  const yourVehicle = vehicle ? `your ${vehicle}` : "your vehicle";
  const dealer = clean(ctx.dealerName) || "Your dealership";
  const shipment = clean(ctx.loadNumber) ? ` (shipment ${clean(ctx.loadNumber)})` : "";
  const capitalized = yourVehicle.charAt(0).toUpperCase() + yourVehicle.slice(1);
  const driver = clean(ctx.driverName);
  const shipmentsUrl = safeShipmentsUrl(ctx.shipmentsUrl);

  const { subject, body } = (() => {
    switch (event) {
      case "booked":
        return {
          subject: `${capitalized} shipment is booked`,
          body: `${dealer} booked the shipment for ${yourVehicle}${shipment}. We'll email you when it's on its way.`,
        };
      case "driver_accepted":
        return {
          subject: `A driver accepted ${yourVehicle} shipment`,
          body: `${driver || "A driver"} accepted the shipment for ${yourVehicle}${shipment}. You can see your driver and follow each step in My Shipments.`,
        };
      case "picked_up":
        return {
          subject: `${capitalized} was picked up`,
          body: `${capitalized} was picked up${driver ? ` by ${driver}` : ""}${shipment}. You'll get a notification in My Shipments at every step until it's delivered.`,
        };
      case "on_the_way":
        return {
          subject: `${capitalized} is on its way`,
          body: `${capitalized} was picked up and is on its way to you${shipment}. Contact ${dealer} if you have questions about the delivery.`,
        };
      case "delivered":
        return {
          subject: `${capitalized} was delivered`,
          body: `${capitalized} was delivered${shipment}. Thank you for choosing ${dealer}. If something isn't right, contact ${dealer}.`,
        };
    }
  })();

  const footer = `Sent by ${dealer} through Suprah AI. You're getting this email because ${dealer} is shipping a vehicle to you.`;
  const text = [
    `Hi ${name},`,
    "",
    body,
    ...(shipmentsUrl ? ["", `Open My Shipments: ${shipmentsUrl}`] : []),
    "",
    footer,
  ].join("\n");
  const button = shipmentsUrl
    ? `
      <p style="margin:24px 0 0;text-align:center;">
        <a href="${escapeHtml(shipmentsUrl)}" style="display:inline-block;background:#10b981;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 24px;border-radius:8px;">Open My Shipments</a>
      </p>`
    : "";
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;color:#1f2937;">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;">
    <div style="background:#10b981;color:#ffffff;padding:24px;text-align:center;">
      <h1 style="margin:0;font-size:20px;">${escapeHtml(subject)}</h1>
      <p style="margin:8px 0 0;opacity:0.9;">${escapeHtml(dealer)}</p>
    </div>
    <div style="padding:24px;font-size:15px;line-height:1.6;">
      <p>Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p>${escapeHtml(body)}</p>${button}
    </div>
    <div style="text-align:center;color:#6b7280;font-size:12px;padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;">
      ${escapeHtml(footer)}
    </div>
  </div>
</body>
</html>`;
  return { subject, text, html };
}

const firstNameOf = (name: unknown) => clean(name).split(" ")[0] || "";

/**
 * Emails the customer about one step of the shipment, when this step is one
 * they get by email (see the top of this file). Never throws: the step has
 * already been saved. Returns whether it was sent.
 */
export async function emailStaffQuoteCustomer(
  organizationId: string,
  quoteId: unknown,
  event: StaffQuoteEmailEvent,
  extra: { loadNumber?: unknown; driverName?: unknown } = {},
): Promise<boolean> {
  const id = String(quoteId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(organizationId) || !mongoose.Types.ObjectId.isValid(id)) return false;
  try {
    const quote = await Quote.findOne({ _id: id, organizationId })
      .select("source requestedBy portalShareOff email firstName vehicleName")
      .lean<{ source?: string; requestedBy?: unknown; portalShareOff?: boolean; email?: string; firstName?: string; vehicleName?: string }>();
    if (!quote) return false;

    const follower = await findQuoteFollower(quote);
    let to: string | null;
    let firstName: string;
    if (follower) {
      if (!FOLLOWER_EMAIL_EVENTS.has(event)) return false;
      to = normalizeIdentityEmail(follower.email);
      firstName = firstNameOf(follower.name) || clean(quote.firstName);
    } else {
      // A portal request whose account is gone, or a step this customer
      // doesn't get by email.
      if (quote.source === "customer_portal" || !STAFF_QUOTE_EMAIL_EVENTS.has(event)) return false;
      to = normalizeIdentityEmail(quote.email);
      firstName = clean(quote.firstName);
    }
    if (!to) return false;

    const org = await Organization.findById(organizationId).select("name").lean<{ name?: string }>();
    const frontend = clean(config.frontendUrl).replace(/\/+$/, "");
    const content = staffQuoteCustomerEmail(event, {
      customerFirstName: firstName,
      vehicleName: quote.vehicleName,
      dealerName: org?.name,
      loadNumber: extra.loadNumber,
      driverName: extra.driverName,
      shipmentsUrl: follower && frontend ? `${frontend}${CUSTOMER_SHIPMENTS_ROUTE}` : "",
    });
    await emailService.sendEmail({ to, ...content, organizationId });
    return true;
  } catch (err) {
    logger.warn({ err, organizationId, quoteId: id, event }, "Could not email the customer a shipment update");
    return false;
  }
}
