import type { IPaymentLineItem } from '../models/Payment.model';

/**
 * Checks and totals the lines of an invoice the dealership sends (2026-11-20).
 *
 * An item (kind product, fee or charge) costs quantity × price. A discount
 * takes its amount off the total. Prices and amounts are in dollars, rounded
 * to the cent. The website sends a discount as quantity 1 and its amount as
 * the price.
 */
export const INVOICE_LINE_KINDS = ['product', 'fee', 'charge', 'discount'] as const;
export type InvoiceLineKind = (typeof INVOICE_LINE_KINDS)[number];

export const MAX_INVOICE_LINES = 50;
export const MAX_LINE_LABEL = 200;
/** The most Stripe takes in one card payment, in US dollars. */
export const MAX_INVOICE_TOTAL = 999_999.99;
/** The longest note to the customer. */
export const CUSTOMER_NOTE_MAX = 1000;

const cents = (value: number) => Math.round(value * 100) / 100;

export type InvoiceLinesResult =
  | { ok: true; lines: IPaymentLineItem[]; subtotal: number }
  | { ok: false; message: string };

export function invoiceLinesFrom(raw: unknown): InvoiceLinesResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: 'Add at least one item to the invoice.' };
  }
  if (raw.length > MAX_INVOICE_LINES) {
    return { ok: false, message: `An invoice can have up to ${MAX_INVOICE_LINES} lines.` };
  }

  const lines: IPaymentLineItem[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const where = `Line ${i + 1}`;
    const line = (raw[i] ?? {}) as Record<string, unknown>;

    const kind = (line.kind ?? 'product') as InvoiceLineKind;
    if (!INVOICE_LINE_KINDS.includes(kind)) return { ok: false, message: `${where} has an unknown type.` };
    const isDiscount = kind === 'discount';

    const label = typeof line.label === 'string' ? line.label.trim() : '';
    if (label.length > MAX_LINE_LABEL) {
      return { ok: false, message: `${where}: keep the description under ${MAX_LINE_LABEL} characters.` };
    }

    const quantity = Number(line.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { ok: false, message: `${where}: enter a quantity greater than 0.` };
    }
    const unitPrice = Number(line.unitPrice);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      return {
        ok: false,
        message: isDiscount ? `${where}: enter the discount amount.` : `${where}: enter a price of $0 or more.`,
      };
    }

    const amount = cents(quantity * cents(unitPrice));
    if (amount > MAX_INVOICE_TOTAL) {
      return { ok: false, message: `${where} is more than $${MAX_INVOICE_TOTAL.toLocaleString('en-US')}.` };
    }
    lines.push({
      label: label || (isDiscount ? 'Discount' : 'Item'),
      kind,
      quantity,
      unitPrice: cents(unitPrice),
      lineTotal: isDiscount ? -amount : amount,
    });
  }

  const subtotal = cents(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  return { ok: true, lines, subtotal };
}

/** A tax rate the dealership can charge: 0 to 100 percent. */
export function taxRateFrom(raw: unknown): number | null {
  const rate = Number(raw ?? 0);
  return Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : null;
}

/** The note shown to the customer on their invoice, trimmed; null when it isn't text or is too long. */
export function customerNoteFrom(raw: unknown): string | undefined | null {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return null;
  const note = raw.trim();
  if (note.length > CUSTOMER_NOTE_MAX) return null;
  return note || undefined;
}
