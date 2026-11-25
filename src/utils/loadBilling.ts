/**
 * Who pays for a load's shipping, and when its driver can be paid through
 * SuprahPay (decisions of 2026-11-25):
 *
 * - A load made from a quote is a customer load: Suprah sends the customer an
 *   automatic SuprahPay shipping invoice at the quote price.
 * - A load made without a quote is "For a customer" (name, email and shipping
 *   price entered in Create Load) or "For the dealership" (Suprah sends the
 *   dealership a SuprahPay invoice for the driver's pay).
 * - A customer load can instead be COP/COD: the customer hands the driver
 *   their pay in cash, outside Suprah, and the driver confirms it.
 * - Pricing skipped: the whole load is settled outside Suprah; the staff pay
 *   the driver directly. Adding pricing later doesn't change that.
 * - Shipping invoices are Suprah's money, never in a dealership's payout. No
 *   tax and no Suprah fee are added. The carrier pay can't be more than the
 *   customer's shipping price.
 * - The driver is paid the carrier pay once the load is delivered and its
 *   invoice is paid.
 */

/** Suprah's own invoices (shipping) use this in place of a dealership id. */
export const SUPRAH_BILLING_ORG = 'suprah';
/** How Suprah's own invoices are signed on screens, Stripe's page and notices. */
export const SUPRAH_ISSUER_NAME = 'Suprah AI';

export const LOAD_BILL_TO = ['customer', 'dealership'] as const;
export const LOAD_BILLING_METHODS = ['suprahpay', 'cop', 'cod'] as const;
export type LoadBillTo = (typeof LOAD_BILL_TO)[number];
export type LoadBillingMethod = (typeof LOAD_BILLING_METHODS)[number];

export interface LoadBillingRecord {
  billTo?: LoadBillTo;
  method?: LoadBillingMethod;
  customerName?: string;
  customerEmail?: string;
  shippingPrice?: number;
  outside?: boolean;
  cashConfirmedAt?: Date | string | null;
}

export interface LoadPricingRecord {
  isPricingEnabled?: boolean;
  carrierPayAmount?: number | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const money = (value: number) => `$${value.toFixed(2)}`;
const twoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

export const isSuprahBilled = (payment: { organizationId?: unknown } | null | undefined): boolean =>
  String(payment?.organizationId ?? '') === SUPRAH_BILLING_ORG;

/** The load's carrier pay when pricing is on, otherwise null. */
export function carrierPayOf(pricing: LoadPricingRecord | null | undefined): number | null {
  if (!pricing || pricing.isPricingEnabled === false) return null;
  const pay = Number(pricing.carrierPayAmount);
  return Number.isFinite(pay) && pay > 0 ? Math.round(pay * 100) / 100 : null;
}

export type BillingResult = { ok: true; billing: LoadBillingRecord } | { ok: false; message: string };

/**
 * The billing a load is saved with, from what staff chose (Create Load, or
 * the question asked the first time an older load's driver is paid). Pricing
 * skipped → settled outside Suprah, whatever was chosen.
 */
export function billingFromInput(input: unknown, pricing: LoadPricingRecord | null | undefined): BillingResult {
  if (pricing?.isPricingEnabled === false) return { ok: true, billing: { outside: true } };
  const raw = (input && typeof input === 'object' ? input : null) as Record<string, unknown> | null;
  if (!raw) return { ok: false, message: 'Choose who pays for this load: a customer or your dealership.' };

  const billTo = raw.billTo;
  if (billTo !== 'customer' && billTo !== 'dealership') {
    return { ok: false, message: 'Choose who pays for this load: a customer or your dealership.' };
  }
  const carrierPay = carrierPayOf(pricing);

  if (billTo === 'dealership') {
    if (raw.method !== undefined && raw.method !== 'suprahpay') {
      return { ok: false, message: 'COP/COD is only for customer loads. A dealership load is billed to your dealership through SuprahPay.' };
    }
    if (carrierPay === null) {
      return { ok: false, message: "Enter the driver's pay first: your dealership is billed that amount through SuprahPay." };
    }
    return { ok: true, billing: { billTo, method: 'suprahpay' } };
  }

  const method = raw.method ?? 'suprahpay';
  if (!(LOAD_BILLING_METHODS as readonly unknown[]).includes(method)) {
    return { ok: false, message: 'Choose how the customer pays: SuprahPay, or cash to the driver (COP or COD).' };
  }
  const customerName = typeof raw.customerName === 'string' ? raw.customerName.trim() : '';
  const customerEmail = typeof raw.customerEmail === 'string' ? raw.customerEmail.trim().toLowerCase() : '';
  if (!customerName || customerName.length > 200) return { ok: false, message: "Enter the customer's name." };
  if (!EMAIL_PATTERN.test(customerEmail) || customerEmail.length > 254) {
    return { ok: false, message: "Enter the customer's email address, for example name@example.com." };
  }
  if (carrierPay === null) {
    return { ok: false, message: "Enter the driver's pay first." };
  }
  if (method !== 'suprahpay') {
    // The customer hands the driver their pay in cash: no SuprahPay invoice.
    return { ok: true, billing: { billTo, method: method as LoadBillingMethod, customerName, customerEmail } };
  }

  const price = typeof raw.shippingPrice === 'number' ? raw.shippingPrice : Number(String(raw.shippingPrice ?? '').trim() || NaN);
  if (!Number.isFinite(price) || price <= 0 || !twoDecimals(price)) {
    return { ok: false, message: 'Enter the shipping price the customer pays, in dollars and cents, for example 650.00.' };
  }
  const shippingPrice = Math.round(price * 100) / 100;
  const capProblem = carrierPayCapProblem(carrierPay, shippingPrice);
  if (capProblem) return { ok: false, message: capProblem };
  return { ok: true, billing: { billTo, method: 'suprahpay', customerName, customerEmail, shippingPrice } };
}

/** The customer's price includes the driver's pay, so the driver's pay can never be more. */
export function carrierPayCapProblem(carrierPay: number | null, shippingPrice: number | null | undefined): string | null {
  if (carrierPay === null || typeof shippingPrice !== 'number') return null;
  if (carrierPay > shippingPrice) {
    return `The driver's pay (${money(carrierPay)}) can't be more than the customer's shipping price (${money(shippingPrice)}). Lower the driver's pay, or raise the shipping price.`;
  }
  return null;
}

/** What the load's automatic SuprahPay invoice is for: who pays and how much. Null when there is none. */
export function invoiceTermsFor(
  billing: LoadBillingRecord | null | undefined,
  pricing: LoadPricingRecord | null | undefined,
): { billedTo: LoadBillTo; amount: number } | null {
  if (!billing || billing.outside || billing.method !== 'suprahpay' || !billing.billTo) return null;
  if (billing.billTo === 'customer') {
    const price = Number(billing.shippingPrice);
    return Number.isFinite(price) && price > 0 ? { billedTo: 'customer', amount: Math.round(price * 100) / 100 } : null;
  }
  const pay = carrierPayOf(pricing);
  return pay === null ? null : { billedTo: 'dealership', amount: pay };
}

export type DriverPayGate =
  | { ok: true; amount: number }
  | { ok: false; code: 'outside' | 'cash' | 'needs_billing' | 'no_amount' | 'awaiting_payment' | 'refunded'; message: string };

/**
 * Whether SuprahPay can pay a delivered load's driver now, and how much (the
 * carrier pay). `invoiceStatus` is the status of the load's automatic invoice.
 */
export function driverPayGate(
  load: { billing?: LoadBillingRecord | null; pricing?: LoadPricingRecord | null },
  invoiceStatus: string | null | undefined,
): DriverPayGate {
  const billing = load.billing ?? null;
  if (load.pricing?.isPricingEnabled === false || billing?.outside) {
    return { ok: false, code: 'outside', message: "Pricing was skipped on this load, so your staff pay the driver directly, outside Suprah." };
  }
  if (!billing?.billTo || !billing.method) {
    return { ok: false, code: 'needs_billing', message: "Choose who pays for this load's shipping first: a customer or your dealership." };
  }
  if (billing.method !== 'suprahpay') {
    return { ok: false, code: 'cash', message: 'The customer pays the driver in cash on this load (COP/COD), so there is nothing to send through SuprahPay.' };
  }
  const amount = carrierPayOf(load.pricing);
  if (amount === null) {
    return { ok: false, code: 'no_amount', message: "Add the driver's pay (Carrier Pay) to this load first." };
  }
  if (invoiceStatus === 'refunded') {
    return { ok: false, code: 'refunded', message: "This load's shipping payment was refunded, so the driver can't be paid through SuprahPay." };
  }
  if (invoiceStatus !== 'succeeded') {
    return {
      ok: false,
      code: 'awaiting_payment',
      message:
        billing.billTo === 'customer'
          ? "The customer hasn't paid this load's shipping invoice yet. The driver can be paid once they do."
          : "Your dealership's SuprahPay bill for this load isn't paid yet. Pay it under Bills from Suprah, then pay the driver.",
    };
  }
  return { ok: true, amount };
}

/** COP/COD: when the driver collects the cash (at pickup, or at delivery). */
export function cashDueNow(method: LoadBillingMethod | undefined, status: string | undefined): boolean {
  if (method === 'cop') return ['Picked Up', 'In-Transit', 'Delivered'].includes(String(status));
  if (method === 'cod') return String(status) === 'Delivered';
  return false;
}
