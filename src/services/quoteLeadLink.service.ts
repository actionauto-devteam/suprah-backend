import mongoose from "mongoose";
import Lead from "../models/lead.model";
import Quote from "../models/Quote.model";
import { normalizeIdentityEmail, normalizeIdentityPhone } from "../utils/contactIdentity";

export interface QuoteLeadLink {
  leadId: mongoose.Types.ObjectId;
  customerRecordId?: mongoose.Types.ObjectId;
}

/**
 * The dealership's existing CRM lead for a quote's customer, so staff can open
 * it from the quote (decided 2026-10-27). A lead with the same email wins over
 * a phone-only match; among equal matches the most recently updated lead is
 * chosen. The lead's customer record comes along when it has one. Leads are
 * never created here; returns null when nothing matches.
 */
export async function findQuoteLeadLink(
  organizationId: string,
  contact: { email?: unknown; phone?: unknown },
): Promise<QuoteLeadLink | null> {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return null;
  const orgId = new mongoose.Types.ObjectId(organizationId);
  const normalizedEmail = normalizeIdentityEmail(contact.email);
  const normalizedPhone = normalizeIdentityPhone(contact.phone);

  const matches: Record<string, string>[] = [];
  if (normalizedEmail) matches.push({ normalizedEmail });
  if (normalizedPhone) matches.push({ normalizedPhone });

  for (const match of matches) {
    const lead = await Lead.findOne({ organizationId: orgId, ...match })
      .sort({ updatedAt: -1 })
      .select("_id customerId")
      .lean<{ _id: mongoose.Types.ObjectId; customerId?: mongoose.Types.ObjectId | null }>();
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
