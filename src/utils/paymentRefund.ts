/**
 * Refund rules shared by the staff Refund action and Stripe's refund notice.
 *
 * A payment can be refunded in parts until the whole amount is back with the
 * customer. A partly refunded payment stays "succeeded" (the customer did
 * pay) and records how much went back in `refundedAmount`; only a full refund
 * marks it "refunded".
 */

export const roundCents = (value: number): number => Math.round(value * 100) / 100;

type RefundablePayment = { amount: number; refundedAmount?: number | null };

/** What is still left to refund on a payment, in dollars. */
export function remainingRefundable(payment: RefundablePayment): number {
  return Math.max(0, roundCents((Number(payment.amount) || 0) - (Number(payment.refundedAmount) || 0)));
}

export type RefundRequest =
  /** `explicit`: staff asked for a specific amount (send it to Stripe);
   *  otherwise refund everything that is left. */
  | { ok: true; amount: number; explicit: boolean }
  | { ok: false; message: string };

/** Checks a requested refund amount (dollars, optional) against the payment. */
export function refundRequestFor(payment: RefundablePayment, requested: unknown): RefundRequest {
  const remaining = remainingRefundable(payment);
  if (remaining <= 0) return { ok: false, message: 'This payment has already been fully refunded.' };

  if (requested === undefined || requested === null || requested === '') {
    return { ok: true, amount: remaining, explicit: false };
  }

  const value =
    typeof requested === 'number'
      ? requested
      : typeof requested === 'string' && requested.trim() !== ''
        ? Number(requested.trim())
        : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: 'Enter a refund amount greater than $0.' };
  }
  if (roundCents(value) !== value) {
    return { ok: false, message: 'Enter the refund amount in dollars and cents, for example 25.50.' };
  }
  if (value > remaining) {
    return { ok: false, message: `You can refund up to $${remaining.toFixed(2)} on this payment.` };
  }
  return { ok: true, amount: value, explicit: true };
}

/** Reads the refund totals from a Stripe charge (amounts are in cents). */
export function refundStateFromCharge(charge: {
  amount_refunded?: number | null;
  refunded?: boolean | null;
}): { refundedAmount: number; fullyRefunded: boolean } {
  return {
    refundedAmount: roundCents((Number(charge.amount_refunded) || 0) / 100),
    fullyRefunded: charge.refunded === true,
  };
}

/**
 * The database update for a refund. `$max` keeps the larger total, so the
 * staff action and Stripe's refund notice can land in either order (or
 * twice) without counting a refund twice or going backwards.
 */
export function refundUpdate(state: { refundedAmount: number; fullyRefunded: boolean }, at: Date) {
  return {
    $max: { refundedAmount: state.refundedAmount },
    $set: { refundedAt: at, ...(state.fullyRefunded ? { status: 'refunded' as const } : {}) },
  };
}
