import { z } from "zod";

// The same email rule as a load stop's (validations/load.validation.ts).
const emailSchema = z.string().trim().email();

/**
 * The person receiving the car when a quote becomes a load (decided
 * 2026-10-29): the quote's customer as the delivery stop's contact name,
 * phone and email. Drivers see a stop's contact only once they're assigned
 * (the load board hides it), and staff can still edit it. A value the load's
 * own stop rules would refuse is left out instead of blocking the conversion.
 */
export function quoteDeliveryContact(quote: {
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
}): { contactName?: string; phone?: string; email?: string } {
  const contactName = [quote.firstName, quote.lastName]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 120)
    .trim();
  const phone = String(quote.phone ?? "").trim();
  const email = String(quote.email ?? "").trim();
  return {
    ...(contactName ? { contactName } : {}),
    ...(phone && phone.length <= 30 ? { phone } : {}),
    ...(email && emailSchema.safeParse(email).success ? { email } : {}),
  };
}
