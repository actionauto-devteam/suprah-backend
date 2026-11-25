/**
 * The invoices a customer still has to deal with: the "To pay" list on their
 * Suprah Pay page. Not paid yet, failed, or a card payment they started that
 * isn't confirmed yet.
 */
export const AWAITING_PAYMENT_STATUSES = ['pending', 'failed', 'processing'] as const;

export function isAwaitingPayment(status?: string | null): boolean {
  return (AWAITING_PAYMENT_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * The invoice details a customer's own screens show (2026-11-20): what they
 * owe, the items, the status, the dates, the receipt, any refund and the
 * dealership's note to them (customerNote). Staff
 * notes, who sent it, and Stripe's and Suprah's internal references stay with
 * the dealership.
 */
export const CUSTOMER_INVOICE_FIELDS = [
  '_id',
  'invoiceNumber',
  'description',
  'amount',
  'subtotal',
  'taxRate',
  'taxAmount',
  'lineItems',
  'currency',
  'status',
  'source',
  // 'customer' marks Suprah's shipping invoice for a booked load (2026-11-25): it can't be cancelled by the customer.
  'billedTo',
  'dueDate',
  'paidAt',
  'receiptUrl',
  'refundedAmount',
  'refundedAt',
  'createdAt',
  'aftermarketProductId',
  'customerNote',
  'purpose',
  'dealershipName',
  'customerName',
  'customerEmail',
] as const;

/** An invoice as a customer receives it: only CUSTOMER_INVOICE_FIELDS. */
export function customerInvoiceView(payment: unknown): Record<string, unknown> | null {
  if (!payment || typeof payment !== 'object') return null;
  const source = payment as { toObject?: () => Record<string, unknown> } & Record<string, unknown>;
  const plain = typeof source.toObject === 'function' ? source.toObject() : source;
  const view: Record<string, unknown> = {};
  for (const field of CUSTOMER_INVOICE_FIELDS) {
    if (plain[field] !== undefined) view[field] = plain[field];
  }
  return view;
}
