import mongoose from "mongoose";
import Quote from "../models/Quote.model";
import Organization from "../models/Organization.model";
import emailService from "./email.service";
import logger from "../utils/logger";
import { normalizeIdentityEmail } from "../utils/contactIdentity";

/*
 * Shipment updates by email for customers whose quote was made by staff
 * (decided 2026-11-02). Customers who asked from the customer portal already
 * get these steps as notifications there, so they aren't emailed. The email
 * names the dealership and is sent through Suprah AI (from the dealership's
 * own connected mailbox when it has one). No driver details or location.
 */

export type StaffQuoteEmailEvent = "booked" | "on_the_way" | "delivered";

export interface StaffQuoteEmailContext {
  customerFirstName?: unknown;
  vehicleName?: unknown;
  dealerName?: unknown;
  loadNumber?: unknown;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

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

  const { subject, body } = (() => {
    switch (event) {
      case "booked":
        return {
          subject: `${capitalized} shipment is booked`,
          body: `${dealer} booked the shipment for ${yourVehicle}${shipment}. We'll email you when it's on its way.`,
        };
      case "on_the_way":
        return {
          subject: `${capitalized} is on its way`,
          body: `${capitalized} was picked up and is on its way to you${shipment}. Contact ${dealer} if you have questions about the delivery.`,
        };
      case "delivered":
        return {
          subject: `${capitalized} was delivered`,
          body: `${capitalized} was delivered${shipment}. Thank you for choosing ${dealer}.`,
        };
    }
  })();

  const footer = `Sent by ${dealer} through Suprah AI. You're getting this email because ${dealer} is shipping a vehicle to you.`;
  const text = [`Hi ${name},`, "", body, "", footer].join("\n");
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
      <p>${escapeHtml(body)}</p>
    </div>
    <div style="text-align:center;color:#6b7280;font-size:12px;padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;">
      ${escapeHtml(footer)}
    </div>
  </div>
</body>
</html>`;
  return { subject, text, html };
}

/**
 * Emails the customer of a staff-made quote about one step of its shipment.
 * Never throws: the step has already been saved. Returns whether it was sent.
 */
export async function emailStaffQuoteCustomer(
  organizationId: string,
  quoteId: unknown,
  event: StaffQuoteEmailEvent,
  extra: { loadNumber?: unknown } = {},
): Promise<boolean> {
  const id = String(quoteId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(organizationId) || !mongoose.Types.ObjectId.isValid(id)) return false;
  try {
    const quote = await Quote.findOne({ _id: id, organizationId })
      .select("source email firstName vehicleName")
      .lean<{ source?: string; email?: string; firstName?: string; vehicleName?: string }>();
    if (!quote || quote.source === "customer_portal") return false;
    const to = normalizeIdentityEmail(quote.email);
    if (!to) return false;
    const org = await Organization.findById(organizationId).select("name").lean<{ name?: string }>();
    const content = staffQuoteCustomerEmail(event, {
      customerFirstName: quote.firstName,
      vehicleName: quote.vehicleName,
      dealerName: org?.name,
      loadNumber: extra.loadNumber,
    });
    await emailService.sendEmail({ to, ...content, organizationId });
    return true;
  } catch (err) {
    logger.warn({ err, organizationId, quoteId: id, event }, "Could not email the customer a shipment update");
    return false;
  }
}
