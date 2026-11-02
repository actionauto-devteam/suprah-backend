import mongoose from "mongoose";
import Lead from "../models/lead.model";
import Quote from "../models/Quote.model";
import Load from "../models/Load.model";
import { normalizeIdentityEmail, normalizeIdentityPhone } from "../utils/contactIdentity";

export interface QuoteLeadLink {
  leadId: mongoose.Types.ObjectId;
  customerRecordId?: mongoose.Types.ObjectId;
}

/**
 * The dealership's existing CRM lead for a quote's customer, so staff can open
 * it from the quote (decided 2026-10-27). A lead with the same email wins over
 * a phone-only match. A customer can have several leads, so among those the
 * lead about the quote's car wins, then the newest lead by when it was created
 * (not last updated: background jobs touch old leads all the time, which made
 * quotes link to a customer's first lead; fixed 2026-11-02). The lead's
 * customer record comes along when it has one. Leads are never created here;
 * returns null when nothing matches.
 */
export async function findQuoteLeadLink(
  organizationId: string,
  contact: { email?: unknown; phone?: unknown },
  car: { vehicleId?: unknown; vin?: unknown } = {},
): Promise<QuoteLeadLink | null> {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  const orgId = new mongoose.Types.ObjectId(organizationId);
  const normalizedEmail = normalizeIdentityEmail(contact.email);
  const normalizedPhone = normalizeIdentityPhone(contact.phone);

  const matches: Record<string, string>[] = [];
  if (normalizedEmail) matches.push({ normalizedEmail });
  if (normalizedPhone) matches.push({ normalizedPhone });

  const vehicleId = String(car.vehicleId ?? "").trim();
  const vin = typeof car.vin === "string" ? car.vin.trim() : "";
  const sameCar: Record<string, unknown>[] = [];
  if (mongoose.Types.ObjectId.isValid(vehicleId)) sameCar.push({ vehicleId: new mongoose.Types.ObjectId(vehicleId) });
  if (vin) sameCar.push({ "vehicle.vin": { $in: [...new Set([vin, vin.toUpperCase()])] } });

  const newest = (filter: Record<string, unknown>) =>
    Lead.findOne(filter)
      .sort({ createdAt: -1 })
      .select("_id customerId")
      .lean<{ _id: mongoose.Types.ObjectId; customerId?: mongoose.Types.ObjectId | null }>();

  for (const match of matches) {
    const base = { organizationId: orgId, ...match };
    const lead = (sameCar.length ? await newest({ ...base, $or: sameCar }) : null) ?? (await newest(base));
    if (lead) {
      return { leadId: lead._id, ...(lead.customerId ? { customerRecordId: lead.customerId } : {}) };
    }
  }
  return null;
}

export interface LoadQuoteOrigin {
  quoteId: string;
  customerName: string;
  lead: { _id: string; firstName?: string; lastName?: string } | null;
}

/**
 * The quote a load came from, with its customer and linked CRM lead, so the
 * load page can show who the shipment is for and open the lead (decided
 * 2026-10-29). Staff pages only. Null when the load has no quote, the quote is
 * gone, or the lookup fails; a lead that was deleted shows as no lead.
 */
export async function findLoadQuoteOrigin(organizationId: string, quoteId: unknown): Promise<LoadQuoteOrigin | null> {
  const id = String(quoteId ?? "").trim();
  if (!organizationId || !mongoose.Types.ObjectId.isValid(id)) return null;
  const quote = await Quote.findOne({ _id: id, organizationId })
    .select("firstName lastName leadId")
    .populate("leadId", "firstName lastName")
    .lean<{
      _id: mongoose.Types.ObjectId;
      firstName?: string;
      lastName?: string;
      leadId?: { _id: mongoose.Types.ObjectId; firstName?: string; lastName?: string } | null;
    }>();
  if (!quote) return null;
  const customerName = [quote.firstName, quote.lastName].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ");
  const lead = quote.leadId && typeof quote.leadId === "object" && "_id" in quote.leadId ? quote.leadId : null;
  return {
    quoteId: String(quote._id),
    customerName,
    lead: lead ? { _id: String(lead._id), firstName: lead.firstName, lastName: lead.lastName } : null,
  };
}

/**
 * The link for a quote made from a specific CRM lead (Create shipping quote on
 * the lead page), only when that lead belongs to this dealership. Null when it
 * doesn't, so the usual email/phone match applies instead.
 */
export async function findLeadLinkById(organizationId: string, leadId: unknown): Promise<QuoteLeadLink | null> {
  const id = String(leadId ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(organizationId) || !mongoose.Types.ObjectId.isValid(id)) return null;
  const lead = await Lead.findOne({ _id: id, organizationId: new mongoose.Types.ObjectId(organizationId) })
    .select("_id customerId")
    .lean<{ _id: mongoose.Types.ObjectId; customerId?: mongoose.Types.ObjectId | null }>();
  if (!lead) return null;
  return { leadId: lead._id, ...(lead.customerId ? { customerRecordId: lead.customerId } : {}) };
}

export interface LeadShipment {
  quoteId: string;
  status: string;
  source: string;
  vehicleName: string;
  /** The quoted car's VIN, so staff can tell two similar cars apart ("" when unknown). */
  vin: string;
  rate: number | null;
  createdAt: string | null;
  /** The newest load made from the quote (a cancelled one only when there's nothing newer). */
  load: { _id: string; loadNumber: string; status: string } | null;
}

/** How many of a lead's quotes the lead page lists, newest first. */
export const LEAD_SHIPMENTS_LIMIT = 20;

/**
 * The shipping quotes linked to a CRM lead, with the load each became, for
 * the lead page (decided 2026-10-30). Staff only, this dealership's records
 * only, read-only, and no driver details.
 */
export async function listLeadShipments(organizationId: string, leadId: unknown): Promise<LeadShipment[]> {
  const id = String(leadId ?? "").trim();
  if (!organizationId || !mongoose.Types.ObjectId.isValid(id)) return [];
  const quotes = await Quote.find({ organizationId, leadId: id })
    .select("_id status source vehicleName vin rate createdAt")
    .sort({ createdAt: -1 })
    .limit(LEAD_SHIPMENTS_LIMIT)
    .lean<any[]>();
  if (quotes.length === 0) return [];

  const loads = await Load.find({ organizationId, quoteId: { $in: quotes.map((quote) => quote._id) } })
    .select("_id quoteId loadNumber status createdAt")
    .sort({ createdAt: -1 })
    .lean<any[]>();
  const loadByQuote = new Map<string, any>();
  for (const load of loads) {
    const key = String(load.quoteId);
    const current = loadByQuote.get(key);
    // Prefer a live load; a cancelled one shows only when it's the only one.
    if (!current || (current.status === "Cancelled" && load.status !== "Cancelled")) loadByQuote.set(key, load);
  }

  return quotes.map((quote) => {
    const load = loadByQuote.get(String(quote._id));
    const created = quote.createdAt ? new Date(quote.createdAt) : null;
    return {
      quoteId: String(quote._id),
      status: String(quote.status ?? ""),
      source: String(quote.source ?? "staff"),
      vehicleName: String(quote.vehicleName ?? "").trim(),
      vin: String(quote.vin ?? "").trim().toUpperCase(),
      rate: typeof quote.rate === "number" && Number.isFinite(quote.rate) ? quote.rate : null,
      createdAt: created && Number.isFinite(created.getTime()) ? created.toISOString() : null,
      load: load ? { _id: String(load._id), loadNumber: String(load.loadNumber ?? ""), status: String(load.status ?? "") } : null,
    };
  });
}
