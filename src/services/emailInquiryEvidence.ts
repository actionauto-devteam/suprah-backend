import Vehicle from '../models/Vehicle.model';
import { gmailHeader } from '../utils/gmailMessageParser';

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
