/**
 * Who pays for a load's shipping, and when its driver can be paid through
 * SuprahPay (decisions of 2026-11-25):
 *
 * - A load made from a quote is a customer load: Suprah sends the customer an
 *   automatic SuprahPay shipping invoice at the quote price.
 * - A load made without a quote is "For a customer" (name, email and shipping
 *   price entered in Create Load) or "For the dealership" (Suprah sends the
 *   dealership a SuprahPay invoice for the driver's pay).
 * - A customer load can instead be cash on delivery (COD): the customer hands
 *   the driver their pay in cash, outside Suprah, and the driver confirms it.
 *   There's no cash on pickup (2026-11-26): the customer collecting the car at
 *   the dealership means there's no shipment.
 * - A car sold to the person receiving it (2026-11-26): the dealership sends
 *   that customer an automatic SuprahPay invoice for the car's price plus
 *   sales tax, on top of the shipping (so two invoices when shipping is
 *   SuprahPay too).
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
/**
 * How the customer pays for shipping: a SuprahPay invoice, or cash to the
 * driver on delivery (COD). There's no cash on pickup: COP means the customer
 * collects the car at the dealership themselves, so there's no shipment
 * (2026-11-26).
 */
export const LOAD_BILLING_METHODS = ['suprahpay', 'cod'] as const;
export type LoadBillTo = (typeof LOAD_BILL_TO)[number];
export type LoadBillingMethod = (typeof LOAD_BILLING_METHODS)[number];

export interface LoadBillingRecord {
  billTo?: LoadBillTo;
  method?: LoadBillingMethod;
  customerName?: string;
  customerEmail?: string;
  shippingPrice?: number;
  /** A car sold to the person receiving it: its price and sales tax, invoiced by the dealership (2026-11-26). */
  vehiclePrice?: number;
  vehicleTaxRate?: number;
  outside?: boolean;
  cashConfirmedAt?: Date | string | null;
}

/** What Create Load knows beyond the billing choice. */
export interface BillingOptions {
  /** Create Load's "the car is sold to the person receiving it". */
  soldToReceiver?: boolean;
  /** The dealership's default sales tax, used when no tax is entered for the car. */
  defaultTaxRate?: number;
}

const MAX_VEHICLE_PRICE = 999_999.99;

/** The car's price and sales tax for a car sold to the receiver, checked. */
function vehicleSaleFrom(raw: unknown, defaultTaxRate = 0): { ok: true; price: number; taxRate: number } | { ok: false; message: string } {
  const sale = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const price = typeof sale.price === 'number' ? sale.price : Number(String(sale.price ?? '').trim() || NaN);
  if (!Number.isFinite(price) || price <= 0 || price > MAX_VEHICLE_PRICE || !twoDecimals(price)) {
    return { ok: false, message: "Enter the car's price the customer pays your dealership, in dollars and cents, for example 18500.00." };
  }
  const rawTax = sale.taxRate;
  const taxRate = rawTax === undefined || rawTax === null || rawTax === '' ? defaultTaxRate : Number(rawTax);
  if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
    return { ok: false, message: "Enter the car's sales tax as a percentage from 0 to 100, for example 7.25." };
  }
  return { ok: true, price: Math.round(price * 100) / 100, taxRate };
}

/** The car invoice's amounts (the same tax rounding as every SuprahPay invoice). */
export function vehicleInvoiceTerms(billing: LoadBillingRecord | null | undefined) {
  const subtotal = Number(billing?.vehiclePrice);
  if (!Number.isFinite(subtotal) || subtotal <= 0) return null;
  const taxRate = Number(billing?.vehicleTaxRate) || 0;
  const taxAmount = Math.round(Math.max(0, subtotal) * taxRate) / 100;
  return { subtotal, taxRate, taxAmount, amount: Math.round((subtotal + taxAmount) * 100) / 100 };
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
export function billingFromInput(
  input: unknown,
  pricing: LoadPricingRecord | null | undefined,
  options: BillingOptions = {},
): BillingResult {
  if (pricing?.isPricingEnabled === false) return { ok: true, billing: { outside: true } };
  const raw = (input && typeof input === 'object' ? input : null) as Record<string, unknown> | null;
  if (!raw) return { ok: false, message: 'Choose who pays for this load: a customer or your dealership.' };

  const billTo = raw.billTo;
  if (billTo !== 'customer' && billTo !== 'dealership') {
    return { ok: false, message: 'Choose who pays for this load: a customer or your dealership.' };
  }
  if (raw.method === 'cop') {
    return {
      ok: false,
      message: "Cash on pickup means the customer collects the car at your dealership, so there's no shipment for a driver. Choose a SuprahPay invoice or cash on delivery (COD).",
    };
  }
  const carrierPay = carrierPayOf(pricing);

  // The customer's details: for a customer load, and for a car sold to the
  // person receiving it (the dealership's car invoice goes to them).
  const sale = options.soldToReceiver ? vehicleSaleFrom(raw.vehicle, options.defaultTaxRate) : null;
  if (sale && !sale.ok) return sale;
  const needsCustomer = billTo === 'customer' || !!sale;
  const customerName = typeof raw.customerName === 'string' ? raw.customerName.trim() : '';
  const customerEmail = typeof raw.customerEmail === 'string' ? raw.customerEmail.trim().toLowerCase() : '';
  if (needsCustomer) {
    if (!customerName || customerName.length > 200) return { ok: false, message: "Enter the customer's name." };
    if (!EMAIL_PATTERN.test(customerEmail) || customerEmail.length > 254) {
      return { ok: false, message: "Enter the customer's email address, for example name@example.com." };
    }
  }
  const saleFields = sale ? { customerName, customerEmail, vehiclePrice: sale.price, vehicleTaxRate: sale.taxRate } : {};

  if (billTo === 'dealership') {
    if (raw.method !== undefined && raw.method !== 'suprahpay') {
      return { ok: false, message: 'Cash on delivery is only for customer loads. A dealership load is billed to your dealership through SuprahPay.' };
    }
    if (carrierPay === null) {
      return { ok: false, message: "Enter the driver's pay first: your dealership is billed that amount through SuprahPay." };
    }
    return { ok: true, billing: { billTo, method: 'suprahpay', ...saleFields } };
  }

  const method = raw.method ?? 'suprahpay';
  if (!(LOAD_BILLING_METHODS as readonly unknown[]).includes(method)) {
    return { ok: false, message: 'Choose how the customer pays for shipping: a SuprahPay invoice, or cash to the driver on delivery (COD).' };
  }
  if (carrierPay === null) {
    return { ok: false, message: "Enter the driver's pay first." };
  }
  if (method !== 'suprahpay') {
    // The customer hands the driver their pay in cash on delivery: no shipping invoice.
    return { ok: true, billing: { billTo, method: method as LoadBillingMethod, customerName, customerEmail, ...saleFields } };
  }

  const price = typeof raw.shippingPrice === 'number' ? raw.shippingPrice : Number(String(raw.shippingPrice ?? '').trim() || NaN);
  if (!Number.isFinite(price) || price <= 0 || !twoDecimals(price)) {
    return { ok: false, message: 'Enter the shipping price the customer pays, in dollars and cents, for example 650.00.' };
  }
  const shippingPrice = Math.round(price * 100) / 100;
  const capProblem = carrierPayCapProblem(carrierPay, shippingPrice);
  if (capProblem) return { ok: false, message: capProblem };
  return { ok: true, billing: { billTo, method: 'suprahpay', customerName, customerEmail, shippingPrice, ...saleFields } };
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
    return { ok: false, code: 'cash', message: 'The customer pays the driver in cash on delivery (COD) on this load, so there is nothing to send through SuprahPay.' };
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

/**
 * Whether the customer pays the driver in cash. 'cop' (cash at pickup) is only
 * on loads saved while testing, before 2026-11-26: they're treated as cash on
 * delivery.
 */
export const isCashMethod = (method: unknown): boolean => method === 'cod' || method === 'cop';

/** Cash on delivery: the driver collects the cash once the load is delivered. */
export function cashDueNow(method: unknown, status: string | undefined): boolean {
  return isCashMethod(method) && String(status) === 'Delivered';
}
