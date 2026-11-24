import { keptAmount } from './paymentDispute';

/**
 * What Suprah owes each dealership (2026-11-21, decisions A4, A5, A6, B6).
 *
 * For each customer payment, the dealership's share is what the payment kept
 * (after refunds and a lost dispute) less Suprah's fee at the rate recorded on
 * the invoice. Stripe's own fees are Suprah's cost and never come off. A
 * payment under an open dispute is held until the bank decides. What a
 * dealership is owed is each share minus what earlier payouts already sent for
 * that payment, so a refund after a payout comes off the next one.
 */

const cents = (n: number) => Math.round(n * 100) / 100;

export const PAYOUT_TIME_ZONE = 'America/Denver';
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function zonedParts(instant: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PAYOUT_TIME_ZONE,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    weekday: 'short', hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: get('weekday'),
  };
}

/** Minutes Utah time is ahead of UTC at that moment (negative: -420 or -360). */
function utahOffsetMinutes(instant: Date): number {
  const p = zonedParts(instant);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
}

/**
 * The start of this week, Monday 00:00 Utah time. Each weekly payout covers
 * payments paid before it ("up to Sunday night").
 */
export function weekStartUtah(now: Date): Date {
  const p = zonedParts(now);
  const daysSinceMonday = Math.max(0, WEEKDAYS.indexOf(p.weekday));
  const localMidnightAsUtc = Date.UTC(p.year, p.month - 1, p.day - daysSinceMonday, 0, 0, 0);
  let instant = localMidnightAsUtc - utahOffsetMinutes(new Date(localMidnightAsUtc)) * 60000;
  // Once more at the found moment, in case daylight saving changed in between.
  instant = localMidnightAsUtc - utahOffsetMinutes(new Date(instant)) * 60000;
  return new Date(instant);
}

export interface PayoutPayment {
  _id: unknown;
  organizationId?: unknown;
  status: string;
  amount: number;
  refundedAmount?: number | null;
  disputeStatus?: string | null;
  disputedAmount?: number | null;
  suprahFeePercent?: number | null;
}

export interface PaymentShare {
  kept: number;
  fee: number;
  share: number;
}

/** What the dealership gets from one payment in total; null while a dispute is open. */
export function dealershipShare(payment: PayoutPayment, currentFeePercent: number): PaymentShare | null {
  if (payment.disputeStatus === 'open') return null;
  const kept = keptAmount(payment);
  const rate = typeof payment.suprahFeePercent === 'number' && Number.isFinite(payment.suprahFeePercent)
    ? payment.suprahFeePercent
    : currentFeePercent;
  const fee = cents((kept * Math.min(100, Math.max(0, rate))) / 100);
  return { kept, fee, share: cents(kept - fee) };
}

export interface OwedSummary {
  /** What to send now (can be zero or less: then nothing is sent and it carries on). */
  amount: number;
  /** New payments covered: what they kept, and Suprah's fee on them. */
  paymentsTotal: number;
  suprahFee: number;
  /** Refunds and lost disputes on payments an earlier payout covered (zero or less). */
  adjustments: number;
  paymentCount: number;
  /** Payments held because of an open dispute. */
  heldCount: number;
  allocations: Array<{ paymentId: string; amount: number }>;
}

/** What one dealership is owed from these payments, given what was already sent for each. */
export function owedFor(
  payments: PayoutPayment[],
  alreadySent: Map<string, number>,
  currentFeePercent: number,
): OwedSummary {
  const owed: OwedSummary = {
    amount: 0, paymentsTotal: 0, suprahFee: 0, adjustments: 0, paymentCount: 0, heldCount: 0, allocations: [],
  };
  for (const payment of payments) {
    const id = String(payment._id);
    const result = dealershipShare(payment, currentFeePercent);
    if (!result) {
      owed.heldCount += 1;
      continue;
    }
    const sent = alreadySent.get(id) ?? 0;
    const delta = cents(result.share - sent);
    if (delta === 0) continue;
    if (sent === 0) {
      owed.paymentsTotal = cents(owed.paymentsTotal + result.kept);
      owed.suprahFee = cents(owed.suprahFee + result.fee);
    } else {
      owed.adjustments = cents(owed.adjustments + delta);
    }
    owed.amount = cents(owed.amount + delta);
    owed.paymentCount += 1;
    owed.allocations.push({ paymentId: id, amount: delta });
  }
  return owed;
}

/* ─────────────────────────── Payout account safety ──────────────────────── */

/**
 * Why a dealership's payouts are on hold (2026-11-23): its payout account was
 * set up and no super admin has confirmed it yet ('new'), it was replaced by
 * another account since it was confirmed ('replaced'), or its bank details
 * changed in Stripe since then ('bank_changed'). Null when payouts can go.
 */
export type PayoutAccountHold = 'new' | 'replaced' | 'bank_changed';

export function payoutAccountHold(suprahPay?: {
  stripeAccountId?: string | null;
  payoutConfirmedAccountId?: string | null;
  payoutBankChangedAt?: Date | null;
} | null): PayoutAccountHold | null {
  if (!suprahPay?.stripeAccountId) return null;
  if (!suprahPay.payoutConfirmedAccountId) return 'new';
  if (suprahPay.payoutConfirmedAccountId !== suprahPay.stripeAccountId) return 'replaced';
  if (suprahPay.payoutBankChangedAt) return 'bank_changed';
  return null;
}

/** What a super admin is told when a payout is held, and what to do. */
export function payoutHoldMessage(hold: PayoutAccountHold): string {
  if (hold === 'replaced') {
    return 'This dealership set up a different payout account since it was confirmed. Check it with the dealership, then press Confirm account.';
  }
  if (hold === 'bank_changed') {
    return "This dealership's bank details changed in Stripe since they were confirmed. Check them with the dealership, then press Confirm account.";
  }
  return "This dealership's payout account hasn't been confirmed yet. Check it with the dealership, then press Confirm account.";
}

/**
 * The bank account Stripe pays a connected account out to (its default for
 * US dollars), when Stripe shares it with Suprah. Null when it doesn't.
 */
export function payoutBankOf(account: {
  external_accounts?: { data?: Array<{ id?: string; object?: string; bank_name?: string | null; last4?: string | null; default_for_currency?: boolean | null }> } | null;
}): { id: string; bankName: string | null; last4: string | null } | null {
  const list = account.external_accounts?.data ?? [];
  const bank = list.find((item) => item?.default_for_currency) ?? list[0];
  if (!bank?.id) return null;
  return { id: bank.id, bankName: bank.bank_name ?? null, last4: bank.last4 ?? null };
}
