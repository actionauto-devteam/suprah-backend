import type Stripe from 'stripe';

type PayoutAccount = Pick<
  Stripe.Account,
  'id' | 'details_submitted' | 'charges_enabled' | 'payouts_enabled' | 'capabilities' | 'requirements'
>;

/**
 * What the Driver Portal shows about a driver's Stripe payout account.
 *
 * Driver accounts only ask Stripe for transfers (they receive money, they
 * never charge cards), so Stripe keeps "charges enabled" off for them. The
 * account is ready when Stripe can send transfers to it and pay them out to
 * the driver's bank (2026-11-19: the portal used to wait for card charges and
 * so never showed a finished account as ready).
 */
export function payoutAccountStatus(account: PayoutAccount) {
  const detailsSubmitted = account.details_submitted === true;
  const payoutsEnabled = account.payouts_enabled === true;
  const transfersActive = account.capabilities?.transfers === 'active';
  const due = [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])];
  return {
    connected: true as const,
    accountId: account.id,
    detailsSubmitted,
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled,
    transfersActive,
    ready: detailsSubmitted && payoutsEnabled && transfersActive,
    /** Stripe is waiting on the driver (as opposed to still checking details). */
    needsMoreInfo: due.length > 0,
  };
}

/** Tells the driver a payout didn't reach them and what to do next. */
export function payoutFailedNotice(loadNumber: string | undefined, amount: number) {
  const load = loadNumber ? `load ${loadNumber}` : 'a delivered load';
  return {
    title: "Payout couldn't be sent",
    message:
      `Your payout of $${amount.toFixed(2)} for ${load} couldn't be sent to your payout account. ` +
      'Open Settings and finish your Stripe payout account, then let your dispatcher know so they can send it again.',
  };
}
