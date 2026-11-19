import { roundCents } from './paymentRefund';

/**
 * Card disputes (chargebacks), 2026-11-20 decision: a disputed payment keeps
 * counting in revenue while the bank reviews it. If the dealership loses, the
 * disputed amount is left out like a refund; if it wins, nothing changes.
 */
export type DisputeOutcome = 'open' | 'won' | 'lost';

/** Stripe's dispute status in Suprah's terms. A closed inquiry or prevented dispute means the money stays. */
export function disputeOutcome(stripeStatus: string): DisputeOutcome {
  if (stripeStatus === 'lost') return 'lost';
  if (stripeStatus === 'won' || stripeStatus === 'warning_closed' || stripeStatus === 'prevented') return 'won';
  return 'open';
}

export interface StripeDisputeLike {
  id: string;
  status: string;
  amount: number; // cents
  reason?: string | null;
}

/** The invoice update for a dispute Stripe reported. */
export function disputeUpdate(dispute: StripeDisputeLike, at: Date) {
  const outcome = disputeOutcome(dispute.status);
  return {
    $set: {
      stripeDisputeId: dispute.id,
      disputeStatus: outcome,
      disputedAmount: roundCents(dispute.amount / 100),
      ...(dispute.reason ? { disputeReason: dispute.reason } : {}),
      ...(outcome === 'open' ? {} : { disputeClosedAt: at }),
    },
    $min: { disputedAt: at },
  };
}

/** Money lost to a dispute the dealership lost (0 otherwise), as a database expression. */
export const LOST_TO_DISPUTE = {
  $cond: [{ $eq: ['$disputeStatus', 'lost'] }, { $ifNull: ['$disputedAmount', 0] }, 0],
};

/** Money a paid payment kept: its amount minus refunds and any dispute lost, never below 0. */
export const KEPT_AMOUNT = {
  $max: [0, { $subtract: [{ $subtract: ['$amount', { $ifNull: ['$refundedAmount', 0] }] }, LOST_TO_DISPUTE] }],
};

export function keptAmount(payment: {
  amount: number;
  refundedAmount?: number | null;
  disputeStatus?: string | null;
  disputedAmount?: number | null;
}): number {
  const lost = payment.disputeStatus === 'lost' ? Number(payment.disputedAmount) || 0 : 0;
  return roundCents(Math.max(0, payment.amount - (Number(payment.refundedAmount) || 0) - lost));
}

/** The note the dealership's admins get about a dispute. */
export function disputeNotice(
  invoice: { invoiceNumber?: string; customerName?: string },
  outcome: DisputeOutcome,
  disputedAmount: number,
): { title: string; message: string } {
  const invoiceText = invoice.invoiceNumber ? ` for invoice ${invoice.invoiceNumber}` : '';
  const what = `${invoice.customerName || 'A customer'}'s payment${invoiceText}`;
  const money = '$' + disputedAmount.toFixed(2);
  if (outcome === 'won') {
    return { title: 'Dispute won', message: `The bank decided the dispute on ${what} in your favour. The ${money} stays with you.` };
  }
  if (outcome === 'lost') {
    return {
      title: 'Dispute lost',
      message: `The bank decided the dispute on ${what} in the customer's favour. ${money} went back to them and no longer counts in your revenue.`,
    };
  }
  return {
    title: 'Payment disputed',
    message: `${what} (${money}) was disputed with their bank. It still counts in your revenue while the bank reviews it.`,
  };
}
