/**
 * What a customer payment is for (2026-11-21, decision B1). Used for reports
 * and shown to the customer on their invoice.
 */
export const PAYMENT_PURPOSES = ['shipping', 'car_deposit', 'aftermarket', 'service', 'down_payment', 'other'] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export const PAYMENT_PURPOSE_LABELS: Record<PaymentPurpose, string> = {
  shipping: 'Shipping',
  car_deposit: 'Deposit to hold a car',
  aftermarket: 'Aftermarket product',
  service: 'Service and repairs',
  down_payment: 'Down payment',
  other: 'Other',
};

/** A known purpose; "other" when none was given; null when the value isn't one of them. */
export function paymentPurposeFrom(raw: unknown): PaymentPurpose | null {
  if (raw === undefined || raw === null || raw === '') return 'other';
  return typeof raw === 'string' && (PAYMENT_PURPOSES as readonly string[]).includes(raw) ? (raw as PaymentPurpose) : null;
}
