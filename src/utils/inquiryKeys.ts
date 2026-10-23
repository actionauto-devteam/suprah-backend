import { createHash } from 'crypto';
import { normalizeIdentityEmail, normalizeIdentityPhone } from './contactIdentity';

export interface InquiryVehicleInput {
  vin?: unknown;
  stock?: unknown;
  year?: unknown;
  make?: unknown;
  model?: unknown;
}

export interface InquiryKeyInput {
  provider?: unknown;
  email?: unknown;
  phone?: unknown;
  vehicle?: InquiryVehicleInput | null;
  comments?: unknown;
  requestDate?: unknown;
}

const clean = (value: unknown) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

const digest = (parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function normalizeProviderName(value: unknown): string {
  return clean(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildProviderInquiryKey(provider: unknown, inquiryId: unknown): string | null {
  const scope = normalizeProviderName(provider);
  const id = String(inquiryId ?? '').trim();
  if (!scope || !id) return null;
  return `${scope}:${id}`;
}

export function inquiryVehicleKey(vehicle?: InquiryVehicleInput | null): string {
  const vin = String(vehicle?.vin ?? '').trim().toUpperCase();
  if (vin) return `vin:${vin}`;
  const stock = clean(vehicle?.stock);
  if (stock) return `stock:${stock}`;
  const parts = [vehicle?.year, vehicle?.make, vehicle?.model].map(clean).filter(Boolean);
  return parts.length ? `ymm:${parts.join('|')}` : '';
}

const TIME_OF_DAY = /\d{1,2}:\d{2}/;
const EXPLICIT_ZONE = /(z|[+-]\d{2}:?\d{2})$/i;

export function requestDateIdentity(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw || !TIME_OF_DAY.test(raw)) return '';
  if (EXPLICIT_ZONE.test(raw)) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return `local:${raw.toLowerCase().replace(/\s+/g, ' ')}`;
}

export function buildInquiryContentKey(input: InquiryKeyInput): string | null {
  const email = normalizeIdentityEmail(input.email) || '';
  const phone = normalizeIdentityPhone(input.phone) || '';
  if (!email && !phone) return null;
  return `content:${digest([
    normalizeProviderName(input.provider),
    email,
    phone,
    inquiryVehicleKey(input.vehicle),
    clean(input.comments),
  ])}`;
}

export function buildInquiryFingerprint(input: InquiryKeyInput): string | null {
  const requestDate = requestDateIdentity(input.requestDate);
  if (!requestDate) return null;
  const contentKey = buildInquiryContentKey(input);
  if (!contentKey) return null;
  return `inquiry:${digest([contentKey, requestDate])}`;
}
