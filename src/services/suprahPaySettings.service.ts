import mongoose from 'mongoose';
import SystemConfig from '../models/SystemConfig.model';
import Organization from '../models/Organization.model';
import { ApiError } from '../utils/ApiError';

/**
 * SuprahPay settings (2026-11-21).
 *
 * Suprah-wide, set by super admins: Suprah's fee on customer payments (starts
 * at 0%) and the largest amount a customer can pay in one payment. Stored in
 * the existing SystemConfig settings store under one key.
 *
 * Per dealership: whether SuprahPay is on (Action Auto Utah pilots it first)
 * and the dealership's default sales tax rate.
 */

export const SUPRAHPAY_CONFIG_KEY = 'suprahpay';
/** The most Stripe takes in one card payment, in US dollars. */
export const STRIPE_MAX_PAYMENT = 999_999.99;

export interface SuprahPayPlatformSettings {
  /** Suprah's fee on each customer payment, in percent (0 to 100). */
  feePercent: number;
  /** The largest amount a customer can pay in one payment, in dollars. */
  maxPaymentAmount: number;
}

export const DEFAULT_PLATFORM_SETTINGS: Readonly<SuprahPayPlatformSettings> = Object.freeze({
  feePercent: 0,
  maxPaymentAmount: STRIPE_MAX_PAYMENT,
});

const hasAtMostTwoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

const validFee = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100 && hasAtMostTwoDecimals(n);

const validLimit = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= STRIPE_MAX_PAYMENT && hasAtMostTwoDecimals(n);

const toNumber = (raw: unknown): number | null => {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim());
  return null;
};

export type PlatformSettingsChange =
  | { ok: true; change: Partial<SuprahPayPlatformSettings> }
  | { ok: false; message: string };

/**
 * Checks a change super admins asked for. Only the two known settings are
 * read; anything else in the request is ignored.
 */
export function platformSettingsChange(raw: unknown): PlatformSettingsChange {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'Send the settings to change.' };
  }
  const body = raw as Record<string, unknown>;
  const change: Partial<SuprahPayPlatformSettings> = {};

  if (body.feePercent !== undefined) {
    const fee = toNumber(body.feePercent);
    if (!validFee(fee)) return { ok: false, message: "Enter Suprah's fee as a percentage from 0 to 100, with up to 2 decimals." };
    change.feePercent = fee;
  }
  if (body.maxPaymentAmount !== undefined) {
    const limit = toNumber(body.maxPaymentAmount);
    if (!validLimit(limit)) {
      return { ok: false, message: 'Enter the largest payment as an amount above $0 and up to $999,999.99.' };
    }
    change.maxPaymentAmount = limit;
  }
  if (!Object.keys(change).length) return { ok: false, message: 'Nothing to change.' };
  return { ok: true, change };
}

/** Stored settings, read safely: anything missing or out of range uses the default. */
export function platformSettingsFrom(stored: unknown): SuprahPayPlatformSettings {
  const value = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  return {
    feePercent: validFee(value.feePercent) ? value.feePercent : DEFAULT_PLATFORM_SETTINGS.feePercent,
    maxPaymentAmount: validLimit(value.maxPaymentAmount) ? value.maxPaymentAmount : DEFAULT_PLATFORM_SETTINGS.maxPaymentAmount,
  };
}

// Read once and kept briefly, so payments don't each look the settings up.
// A change made on another server shows here within this time.
const CACHE_MS = 30_000;
let cached: { value: SuprahPayPlatformSettings; at: number } | null = null;

export function clearPlatformSettingsCache() {
  cached = null;
}

export async function getPlatformSettings(): Promise<SuprahPayPlatformSettings> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const doc = await SystemConfig.findOne({ key: SUPRAHPAY_CONFIG_KEY }).select('value').lean();
  const value = platformSettingsFrom((doc as { value?: unknown } | null)?.value);
  cached = { value, at: Date.now() };
  return value;
}

/** Saves a checked change and returns the settings now in force. */
export async function savePlatformSettings(
  change: Partial<SuprahPayPlatformSettings>,
): Promise<SuprahPayPlatformSettings> {
  const current = await getPlatformSettings();
  const next = platformSettingsFrom({ ...current, ...change });
  await SystemConfig.findOneAndUpdate(
    { key: SUPRAHPAY_CONFIG_KEY },
    { $set: { value: next, description: "SuprahPay: Suprah's fee and the largest payment (super admins)" } },
    { upsert: true, new: true },
  );
  cached = { value: next, at: Date.now() };
  return next;
}

/* ─────────────────────────── Per dealership ─────────────────────────────── */

export interface DealershipSuprahPayFields {
  suprahPay?: { enabled?: boolean | null; defaultTaxRate?: number | null } | null;
  subscription?: { tier?: string | null } | null;
}

/**
 * Whether SuprahPay is on for a dealership. A super admin's switch decides;
 * until one is set, it is on only for Suprah's own Origin dealerships (Action
 * Auto Utah, the pilot), so the pilot needs no setup.
 */
export function suprahPayOn(org: DealershipSuprahPayFields | null | undefined): boolean {
  if (!org) return false;
  const enabled = org.suprahPay?.enabled;
  if (typeof enabled === 'boolean') return enabled;
  return org.subscription?.tier === 'suprah_origin';
}

/** The dealership's default sales tax rate in percent (0 when not set). */
export function dealershipTaxRate(org: DealershipSuprahPayFields | null | undefined): number {
  const rate = org?.suprahPay?.defaultTaxRate;
  return typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : 0;
}

/** Checks a dealership's default tax rate: 0 to 100 percent, up to 3 decimals (e.g. 8.375%). */
export function taxRateSetting(raw: unknown): number | null {
  const rate = toNumber(raw);
  if (rate === null || !Number.isFinite(rate) || rate < 0 || rate > 100) return null;
  return Math.abs(Math.round(rate * 1000) - rate * 1000) < 1e-6 ? rate : null;
}

export const SUPRAHPAY_OFF_MESSAGE =
  "SuprahPay isn't turned on for your dealership yet. Ask your Suprah contact to turn it on.";

/* ─────────────────────── Checks when a payment is made ───────────────────── */

export interface DealershipForPayments {
  name: string;
  defaultTaxRate: number;
  feePercent: number;
  maxPaymentAmount: number;
}

/**
 * Loads what a new invoice needs from the dealership and Suprah's settings,
 * and refuses when SuprahPay isn't on for the dealership (2026-11-21).
 */
export async function dealershipForPayments(orgId: string | undefined | null): Promise<DealershipForPayments> {
  if (!orgId || !mongoose.isValidObjectId(orgId)) throw new ApiError(400, 'Choose a dealership first.');
  const [org, platform] = await Promise.all([
    Organization.findById(orgId).select('name subscription.tier suprahPay').lean(),
    getPlatformSettings(),
  ]);
  if (!org) throw new ApiError(404, "Your dealership couldn't be found.");
  if (!suprahPayOn(org)) throw new ApiError(403, SUPRAHPAY_OFF_MESSAGE);
  return {
    name: String(org.name || ''),
    defaultTaxRate: dealershipTaxRate(org),
    feePercent: platform.feePercent,
    maxPaymentAmount: platform.maxPaymentAmount,
  };
}

const dollars = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Why an amount can't be paid online, or null when it can. */
export function paymentLimitProblem(amount: number, maxPaymentAmount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return 'The amount must be more than $0.';
  if (amount > maxPaymentAmount) {
    return `This is more than SuprahPay's limit of ${dollars(maxPaymentAmount)} for one payment. Split it into smaller payments, or contact Suprah.`;
  }
  return null;
}
