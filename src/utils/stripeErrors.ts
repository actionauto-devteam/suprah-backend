import { SUPPORT_EMAIL } from './userMessages';

/**
 * Stripe's own error text is written for Suprah's developers: it can name
 * dashboard pages, developer tools and how Suprah's Stripe account is set up.
 * It never reaches a screen (2026-11-23). People see a plain message that
 * says what happened and what to do; the server log keeps Stripe's error
 * type, code and request id, which find the full error in Stripe's logs.
 */

type StripeLikeError = {
  type?: unknown;
  code?: unknown;
  decline_code?: unknown;
  statusCode?: unknown;
  requestId?: unknown;
  param?: unknown;
};

const fieldsOf = (err: unknown): StripeLikeError =>
  err && typeof err === 'object' ? (err as StripeLikeError) : {};

/** An error thrown by the Stripe library (StripeCardError, StripeInvalidRequestError, …). */
export function isStripeError(err: unknown): boolean {
  const { type } = fieldsOf(err);
  return typeof type === 'string' && type.startsWith('Stripe');
}

/** Stripe couldn't be reached or was busy, so trying again shortly can work. */
export function isTemporaryStripeError(err: unknown): boolean {
  const type = String(fieldsOf(err).type ?? '');
  return type === 'StripeConnectionError' || type === 'StripeAPIError' || type === 'StripeRateLimitError';
}

/**
 * What the server log keeps about a Stripe error: never its message, which
 * can repeat values that were sent (an email address, for example).
 */
export function stripeErrorForLog(err: unknown) {
  const e = fieldsOf(err);
  return {
    stripeType: e.type,
    stripeCode: e.code,
    stripeDeclineCode: e.decline_code,
    stripeStatus: e.statusCode,
    stripeRequestId: e.requestId,
    stripeParam: e.param,
  };
}

export const PAYMENTS_UNREACHABLE =
  "Payments couldn't be reached just now, so this wasn't completed. Try again in a moment.";
export const PAYMENTS_UNAVAILABLE =
  `This payment action couldn't be completed right now. Please try again later. If it keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`;
export const CARD_DECLINED =
  "The card was declined, so nothing was charged. Try another card, or contact the card's bank.";

/** The plain message for any Stripe error when nothing more specific applies. */
export function stripeProblemMessage(err: unknown): string {
  if (fieldsOf(err).type === 'StripeCardError') return CARD_DECLINED;
  return isTemporaryStripeError(err) ? PAYMENTS_UNREACHABLE : PAYMENTS_UNAVAILABLE;
}

/** Setting up a payout account (dealership admins and drivers). */
export function payoutSetupProblemMessage(err: unknown): string {
  return isTemporaryStripeError(err)
    ? "Payout account setup couldn't be reached just now. Try again in a moment."
    : `Payout account setup isn't available right now. Please try again later. If it keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`;
}

/** Why a card payment failed, from the payment's last error, in plain words. */
export function cardFailureReason(lastError: unknown): string {
  const e = fieldsOf(lastError);
  const code = String(e.code ?? '');
  const decline = String(e.decline_code ?? '');
  if (code === 'expired_card' || decline === 'expired_card') return 'The card has expired. Use another card.';
  if (code === 'incorrect_cvc' || code === 'invalid_cvc' || decline === 'incorrect_cvc') {
    return "The card's security code was wrong. Check it and try again.";
  }
  if (code === 'incorrect_number' || code === 'invalid_number' || decline === 'incorrect_number') {
    return 'The card number was wrong. Check it and try again.';
  }
  if (decline === 'insufficient_funds') return "The card doesn't have enough funds. Use another card.";
  if (code === 'processing_error' || decline === 'processing_error') {
    return "The card couldn't be processed. Try again in a moment.";
  }
  if (code === 'authentication_required' || code === 'payment_intent_authentication_failure' || decline === 'authentication_required') {
    return "The card's bank couldn't confirm the payment. Try again and finish the bank's check, or use another card.";
  }
  if (e.type === 'card_error' || code === 'card_declined') return CARD_DECLINED;
  return "The payment didn't go through, so nothing was charged. Try again, or use another card.";
}

/** Why a refund didn't go through (staff with Finance access). */
export function refundProblemMessage(err: unknown): string {
  const code = String(fieldsOf(err).code ?? '');
  if (code === 'charge_already_refunded') {
    return 'The refund didn\'t go through because this payment was already fully refunded. Refresh to see its latest status.';
  }
  if (code === 'charge_disputed') {
    return "The refund didn't go through because the customer's bank has an open dispute on this payment. Wait until the dispute is decided.";
  }
  if (isTemporaryStripeError(err)) {
    return "The refund didn't go through, so nothing was refunded. Payments couldn't be reached just now; try again in a moment.";
  }
  return `The refund didn't go through, so nothing was refunded. Please try again later. If it keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`;
}

/** Why a driver payout wasn't sent, as saved on the payout (staff and the driver see it). */
export function driverPayoutFailureReason(err: unknown): string {
  if (String(fieldsOf(err).code ?? '') === 'balance_insufficient') {
    return "There wasn't enough available money for this payout yet. Card payments take a few days to become available; try again later.";
  }
  if (isTemporaryStripeError(err)) return "Payments couldn't be reached when this payout was sent. Try again in a moment.";
  return "The payout wasn't sent. Check that the driver's payout account is fully set up, then try again.";
}
