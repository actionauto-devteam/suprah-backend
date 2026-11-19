/** Checks for a customer's Refer & Earn withdrawal request. */

export const WITHDRAWAL_METHODS = ['venmo', 'paypal', 'bank_transfer', 'check'] as const;
export type WithdrawalMethod = (typeof WITHDRAWAL_METHODS)[number];

const MAX_DETAILS_LENGTH = 500;

export type WithdrawalRequest =
  | { ok: true; amount: number; methodType: WithdrawalMethod; methodDetails: string }
  | { ok: false; message: string };

export function withdrawalRequestFrom(body: unknown): WithdrawalRequest {
  const { amount, methodType, methodDetails } = (body ?? {}) as Record<string, unknown>;

  const value =
    typeof amount === 'number'
      ? amount
      : typeof amount === 'string' && amount.trim() !== ''
        ? Number(amount.trim())
        : Number.NaN;
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: 'Enter an amount greater than $0 to withdraw.' };
  }
  if (Math.round(value * 100) / 100 !== value) {
    return { ok: false, message: 'Enter the amount in dollars and cents, for example 25.50.' };
  }

  if (typeof methodType !== 'string' || !(WITHDRAWAL_METHODS as readonly string[]).includes(methodType)) {
    return { ok: false, message: 'Choose how to receive the money: Venmo, PayPal, bank transfer or check.' };
  }

  const details = typeof methodDetails === 'string' ? methodDetails.trim() : '';
  if (!details) {
    return { ok: false, message: 'Add where to send the money, for example your Venmo or PayPal username.' };
  }
  if (details.length > MAX_DETAILS_LENGTH) {
    return { ok: false, message: `Keep the payment details under ${MAX_DETAILS_LENGTH} characters.` };
  }

  return { ok: true, amount: value, methodType: methodType as WithdrawalMethod, methodDetails: details };
}
