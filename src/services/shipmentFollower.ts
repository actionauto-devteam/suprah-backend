import mongoose from "mongoose";
import User from "../models/User.model";
import { normalizeIdentityEmail } from "../utils/contactIdentity";

/*
 * Who follows a shipment in the customer portal's My Shipments (decided
 * 2026-11-05):
 * - a request the customer sent from the portal: that customer;
 * - a quote made by staff: the customer account whose VERIFIED email is the
 *   quote's email, unless staff stopped sharing it with "Unlink".
 * Loads made without a quote stay staff-only.
 *
 * The match is worked out when it's needed, so a customer who signs up or
 * verifies their email later, or a quote whose email staff correct, follows
 * the right account without any extra step.
 */

export interface PortalCustomer {
  id: string;
  name: string;
  email: string;
}

export interface ShipmentFollower extends PortalCustomer {
  /** "request": they asked from the portal. "shared": a staff quote with their email. */
  kind: "request" | "shared";
}

export interface FollowableQuote {
  source?: string | null;
  requestedBy?: unknown;
  email?: unknown;
  portalShareOff?: boolean | null;
}

const ACCOUNT_FIELDS = "_id name email";

const toPortalCustomer = (user: any): PortalCustomer => ({
  id: String(user._id),
  name: String(user.name ?? "").trim(),
  email: String(user.email ?? "").trim().toLowerCase(),
});

/** A staff-made quote (not a request from the customer portal). */
export function isStaffQuote(quote: FollowableQuote): boolean {
  return quote.source !== "customer_portal";
}

/** The active customer account with this verified email, or null. */
export async function findPortalCustomerByEmail(email: unknown): Promise<PortalCustomer | null> {
  const normalized = normalizeIdentityEmail(email);
  if (!normalized) return null;
  const user = await User.findOne({ email: normalized, role: "customer", emailVerified: true, isActive: true })
    .select(ACCOUNT_FIELDS)
    .lean();
  return user ? toPortalCustomer(user) : null;
}

/** Active, verified customer accounts for these emails, keyed by email. One query. */
export async function findPortalCustomersByEmail(emails: unknown[]): Promise<Map<string, PortalCustomer>> {
  const wanted = [...new Set(emails.map((email) => normalizeIdentityEmail(email)).filter((email): email is string => Boolean(email)))];
  if (wanted.length === 0) return new Map();
  const users = await User.find({ email: { $in: wanted }, role: "customer", emailVerified: true, isActive: true })
    .select(ACCOUNT_FIELDS)
    .lean();
  return new Map(users.map((user) => [String(user.email).toLowerCase(), toPortalCustomer(user)]));
}

export interface PortalCustomerSummary {
  name: string;
  /** False when staff unlinked a staff quote ("Link again" turns it back on). */
  shared: boolean;
  /** The customer asked for it from the portal: it always shows there. */
  fromRequest: boolean;
}

/**
 * What staff see on the load page about the customer's portal account, even
 * while it's unlinked, so they can link it again. Null when no account follows
 * or could follow it.
 */
export async function describePortalCustomer(quote: FollowableQuote | null | undefined): Promise<PortalCustomerSummary | null> {
  if (!quote) return null;
  if (!isStaffQuote(quote)) {
    const follower = await findQuoteFollower(quote);
    return follower ? { name: follower.name || "Customer", shared: true, fromRequest: true } : null;
  }
  const account = await findPortalCustomerByEmail(quote.email);
  return account ? { name: account.name || "Customer", shared: !quote.portalShareOff, fromRequest: false } : null;
}

/** The customer who follows this quote's shipment in their portal, or null. */
export async function findQuoteFollower(quote: FollowableQuote | null | undefined): Promise<ShipmentFollower | null> {
  if (!quote) return null;
  if (!isStaffQuote(quote)) {
    const id = String(quote.requestedBy ?? "").trim();
    if (!mongoose.Types.ObjectId.isValid(id)) return null;
    const user = await User.findById(id).select(ACCOUNT_FIELDS).lean();
    return user ? { ...toPortalCustomer(user), kind: "request" } : null;
  }
  if (quote.portalShareOff) return null;
  const customer = await findPortalCustomerByEmail(quote.email);
  return customer ? { ...customer, kind: "shared" } : null;
}
