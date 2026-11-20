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

const alnum = (value: unknown) => clean(value).replace(/[^a-z0-9]+/g, '');

export type InquiryVehicleMatch = 'same' | 'different' | 'unknown';

export function compareInquiryVehicles(a?: InquiryVehicleInput | null, b?: InquiryVehicleInput | null): InquiryVehicleMatch {
  const vinA = alnum(a?.vin);
  const vinB = alnum(b?.vin);
  if (vinA && vinB) return vinA === vinB ? 'same' : 'different';
  const stockA = alnum(a?.stock);
  const stockB = alnum(b?.stock);
  if (stockA && stockB) return stockA === stockB ? 'same' : 'different';
  const ymmA = [alnum(a?.year), alnum(a?.make), alnum(a?.model)];
  const ymmB = [alnum(b?.year), alnum(b?.make), alnum(b?.model)];
  if (ymmA.every(Boolean) && ymmB.every(Boolean)) {
    const shorter = Math.min(ymmA[2].length, ymmB[2].length);
    const sameModel = ymmA[2] === ymmB[2] || (shorter >= 3 && (ymmA[2].startsWith(ymmB[2]) || ymmB[2].startsWith(ymmA[2])));
    return ymmA[0] === ymmB[0] && ymmA[1] === ymmB[1] && sameModel ? 'same' : 'different';
  }
  return 'unknown';
}

export function inquiryNamesVehicle(vehicle?: InquiryVehicleInput | null): boolean {
  return [vehicle?.vin, vehicle?.stock, vehicle?.year, vehicle?.make, vehicle?.model].some((part) => Boolean(alnum(part)));
}

export function inquiryNamesUnit(vehicle?: InquiryVehicleInput | null): boolean {
  return Boolean(alnum(vehicle?.vin) || alnum(vehicle?.stock));
}

export function sameInquiryUnit(a?: InquiryVehicleInput | null, b?: InquiryVehicleInput | null): boolean {
  const vinA = alnum(a?.vin);
  const vinB = alnum(b?.vin);
  if (vinA && vinB) return vinA === vinB;
  const stockA = alnum(a?.stock);
  const stockB = alnum(b?.stock);
  return Boolean(stockA && stockB && stockA === stockB);
}

const words = (value: unknown) => clean(value).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function inquiryHasText(value: unknown): boolean {
  return Boolean(words(value));
}

export function inquiryTextAddsNothing(earlier: unknown, later: unknown): boolean {
  const before = words(earlier);
  const after = words(later);
  if (!after) return true;
  if (!before) return false;
  return before === after || (after.length >= 12 && before.includes(after));
}

export const SAME_REQUEST_WINDOW_MS = 2 * 60 * 60 * 1000;

export const CLOSED_LEAD_COPY_WINDOW_MS = 30 * 60 * 1000;

function laterAddsUnit(earlier?: InquiryVehicleInput | null, later?: InquiryVehicleInput | null): boolean {
  const vinBefore = alnum(earlier?.vin);
  const vinAfter = alnum(later?.vin);
  if (vinAfter) return !vinBefore;
  return Boolean(alnum(later?.stock) && !alnum(earlier?.stock));
}

export function isSameRequest(earlier: any, later: any): boolean {
  const vehicles = compareInquiryVehicles(earlier?.vehicle, later?.vehicle);
  if (vehicles === 'different') return false;
  if (vehicles === 'same') return !laterAddsUnit(earlier?.vehicle, later?.vehicle) && inquiryTextAddsNothing(earlier?.comments, later?.comments);
  if (inquiryNamesVehicle(earlier?.vehicle) || inquiryNamesVehicle(later?.vehicle)) return false;
  return inquiryHasText(later?.comments) && inquiryTextAddsNothing(earlier?.comments, later?.comments);
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
