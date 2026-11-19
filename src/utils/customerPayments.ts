/**
 * The invoices a customer still has to deal with: the "To pay" list on their
 * Suprah Pay page. Not paid yet, failed, or a card payment they started that
 * isn't confirmed yet.
 */
export const AWAITING_PAYMENT_STATUSES = ['pending', 'failed', 'processing'] as const;

export function isAwaitingPayment(status?: string | null): boolean {
  return (AWAITING_PAYMENT_STATUSES as readonly string[]).includes(status ?? '');
}
