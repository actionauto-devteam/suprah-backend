import { normalizeIdentityEmail } from './contactIdentity';

export const LEAD_SOURCE_EMAILS = ['leads@dealerscloud.com', 'actionautoutah.dev@gmail.com'];

export const NO_CUSTOMER_EMAIL_MESSAGE =
  "This lead has no customer email on file. Add the customer's email in the contact details before replying by email.";

export class LeadReplyRecipientError extends Error {
  readonly code = 'NO_CUSTOMER_EMAIL';

  constructor(message = NO_CUSTOMER_EMAIL_MESSAGE) {
    super(message);
    this.name = 'LeadReplyRecipientError';
  }
}

type RecipientLead = {
  email?: unknown;
  senderEmail?: unknown;
  channel?: unknown;
  centralIngestion?: unknown;
} | null | undefined;

export function resolveLeadReplyRecipient(lead: RecipientLead, dealershipAddresses: unknown[] = []): string | null {
  const blocked = new Set(
    [...LEAD_SOURCE_EMAILS, ...dealershipAddresses]
      .map((address) => normalizeIdentityEmail(address))
      .filter((address): address is string => Boolean(address)),
  );
  const savedEmail = normalizeIdentityEmail(lead?.email);
  if (savedEmail) return blocked.has(savedEmail) ? null : savedEmail;
  if (lead?.channel === 'adf' || lead?.centralIngestion === true) return null;
  const senderEmail = normalizeIdentityEmail(lead?.senderEmail);
  return senderEmail && !blocked.has(senderEmail) ? senderEmail : null;
}
