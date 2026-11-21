import Vehicle from '../models/Vehicle.model';
import { gmailHeader } from '../utils/gmailMessageParser';
import { FREE_MAIL_DOMAINS } from '../utils/freeMailDomains';

type GmailLike = { payload?: any } | null | undefined;

const BULK_PRECEDENCE = ['bulk', 'junk', 'list', 'auto_reply'];
const VIN_PATTERN = /\b[A-HJ-NPR-Z0-9]{17}\b/gi;
const STOCK_PATTERN = /\bstock\s*(?:#|no\.?|number)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{2,15})\b/gi;
const YEAR_MAKE_MODEL_PATTERN = /\b(19[89]\d|20[0-4]\d)\s+([A-Za-z][A-Za-z-]{1,20})\s+([A-Za-z0-9][A-Za-z0-9-]{0,20})/g;

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function isAutomatedEmail(message: GmailLike): boolean {
  const autoSubmitted = gmailHeader(message, 'auto-submitted').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (BULK_PRECEDENCE.includes(gmailHeader(message, 'precedence').trim().toLowerCase())) return true;
  if (gmailHeader(message, 'x-autoreply') || gmailHeader(message, 'x-autorespond')) return true;
  return Boolean(gmailHeader(message, 'list-unsubscribe') || gmailHeader(message, 'list-id'));
}

const AUTO_REPLY_SENDER = /^(mailer[-_.]?daemon|postmaster|bounces?)\b/i;
const AUTO_REPLY_SUBJECTS = [
  /^\s*(auto(matic)?[- ]?reply|out of (the )?office|ooo\b|away from (my|the) (desk|office))/i,
  /\b(delivery status notification|undeliver(able|ed)|mail delivery (failed|subsystem)|returned mail|failure notice|address not found)\b/i,
];
const NO_REPLY_SENDER = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply)/i;

export type PlainEmailRoute =
  | { route: 'dismiss'; reason: string }
  | { route: 'others'; reason: string }
  | { route: 'customer' };

export function isAutoReplyEmail(message: GmailLike, subject: string, fromEmail: string): boolean {
  if (gmailHeader(message, 'auto-submitted').trim().toLowerCase() === 'auto-replied') return true;
  if (gmailHeader(message, 'x-autoreply') || gmailHeader(message, 'x-autorespond')) return true;
  if (gmailHeader(message, 'precedence').trim().toLowerCase() === 'auto_reply') return true;
  if (AUTO_REPLY_SENDER.test(String(fromEmail || '').split('@')[0] || '')) return true;
  return AUTO_REPLY_SUBJECTS.some((pattern) => pattern.test(String(subject || '')));
}

export function isBulkOrSystemEmail(message: GmailLike, fromEmail: string): boolean {
  const autoSubmitted = gmailHeader(message, 'auto-submitted').trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (['bulk', 'junk', 'list'].includes(gmailHeader(message, 'precedence').trim().toLowerCase())) return true;
  if (gmailHeader(message, 'list-unsubscribe') || gmailHeader(message, 'list-id')) return true;
  return NO_REPLY_SENDER.test(String(fromEmail || '').split('@')[0] || '');
}

export function classifyPlainEmail(input: {
  message: GmailLike;
  subject: string;
  senderAddress: string;
  staffEmails: Set<string>;
  ownDomains: Set<string>;
  notLeadSenders: Set<string>;
}): PlainEmailRoute {
  const sender = String(input.senderAddress || '').toLowerCase();
  const domain = sender.split('@')[1] || '';
  if (isAutoReplyEmail(input.message, input.subject, sender)) return { route: 'dismiss', reason: 'automated_email' };
  if (input.notLeadSenders.has(sender)) return { route: 'others', reason: 'Sender marked Not a lead' };
  if (input.staffEmails.has(sender)) return { route: 'others', reason: 'From a team member' };
  if (domain && input.ownDomains.has(domain) && !FREE_MAIL_DOMAINS.has(domain)) return { route: 'others', reason: 'From our own email' };
  if (isBulkOrSystemEmail(input.message, sender)) return { route: 'others', reason: 'Mass email or automatic notice' };
  return { route: 'customer' };
}

export function forwardedFromAddress(message: GmailLike, ownAddresses: Set<string>): string {
  const tokens = gmailHeader(message, 'x-forwarded-for').split(/[\s,;]+/).map((value) => value.trim().toLowerCase()).filter(Boolean);
  return tokens.find((value) => value.includes('@') && !ownAddresses.has(value)) || '';
}

export function senderDisplayName(from: string): { firstName?: string; lastName?: string } {
  const raw = String(from || '').replace(/<[^<>]*>/g, '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!raw || raw.includes('@')) return {};
  const parts = raw.split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined };
}

export function emailMessageIdOf(message: GmailLike): string {
  return gmailHeader(message, 'message-id').trim().replace(/^<|>$/g, '').trim().toLowerCase();
}

export function isEmailReply(message: GmailLike, subject: string): boolean {
  if (gmailHeader(message, 'in-reply-to') || gmailHeader(message, 'references')) return true;
  return /^\s*(re|fw|fwd)\s*:/i.test(subject || '');
}

export interface VehicleReference {
  vehicle: any;
  match: 'vin' | 'stock' | 'year_make_model';
}

export async function findInventoryVehicleReference(organizationId: string, text: string): Promise<VehicleReference | null> {
  const source = String(text || '').slice(0, 20000);
  const base = { organizationId, isDeleted: { $ne: true } };
  const select = '_id year make modelName trim vin stockNumber dealerCity';

  const vins = [...new Set((source.match(VIN_PATTERN) || [])
    .map((value) => value.toUpperCase())
    .filter((value) => /\d/.test(value) && /[A-Z]/.test(value)))];
  if (vins.length) {
    const vehicle = await Vehicle.findOne({ ...base, vin: { $in: vins } }).select(select).lean();
    if (vehicle) return { vehicle, match: 'vin' };
  }

  const stocks = [...new Set([...source.matchAll(STOCK_PATTERN)].map((match) => match[1]))].slice(0, 5);
  for (const stock of stocks) {
    const vehicle = await Vehicle.findOne({ ...base, stockNumber: new RegExp(`^${escapeRegex(stock)}$`, 'i') }).select(select).lean();
    if (vehicle) return { vehicle, match: 'stock' };
  }

  const mentions = [...source.matchAll(YEAR_MAKE_MODEL_PATTERN)].slice(0, 5);
  for (const [, year, make, model] of mentions) {
    const vehicle = await Vehicle.findOne({
      ...base,
      year: Number(year),
      make: new RegExp(`^${escapeRegex(make)}$`, 'i'),
      modelName: new RegExp(`^${escapeRegex(model)}`, 'i'),
    }).select(select).lean();
    if (vehicle) return { vehicle, match: 'year_make_model' };
  }
  return null;
}
