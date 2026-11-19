import Payment from '../models/Payment.model';

/**
 * Marks an invoice paid exactly once.
 *
 * Stripe can report the same payment more than once: its update can arrive
 * twice, or at the same moment the customer comes back to Suprah. Each place
 * used to check "not paid yet" and then save, so two at once could both send
 * the "Payment Received" notice and the other follow-ups. Now only the first
 * caller gets the updated invoice back; everyone else gets null and skips the
 * follow-ups. A refunded invoice is never turned back into a paid one.
 */
export function claimPaid(filter: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  return Payment.findOneAndUpdate(
    { ...filter, status: { $nin: ['succeeded', 'refunded'] } },
    { $set: { ...fields, status: 'succeeded', paidAt: new Date() } },
    { new: true },
  );
}

/** Records a failed card payment unless the invoice was already paid or refunded. */
export function claimFailed(filter: Record<string, unknown>, failureReason: string) {
  return Payment.findOneAndUpdate(
    { ...filter, status: { $nin: ['succeeded', 'refunded', 'cancelled'] } },
    { $set: { status: 'failed', failureReason } },
    { new: true },
  );
}
