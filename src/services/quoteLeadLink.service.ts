import mongoose from "mongoose";
import Lead from "../models/lead.model";
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
