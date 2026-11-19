/**
 * Suprah Pay batch 3 (2026-11-20), one section per fix. Stripe, the database
 * and notifications are stand-ins: nothing here talks to Stripe or a database.
 */
jest.mock('stripe', () => {
  const instance = {
    webhooks: { constructEvent: jest.fn() },
    paymentIntents: { retrieve: jest.fn(), create: jest.fn(), cancel: jest.fn() },
    charges: { retrieve: jest.fn() },
    customers: { list: jest.fn(), create: jest.fn() },
    checkout: { sessions: { retrieve: jest.fn(), create: jest.fn(), expire: jest.fn() } },
  };
  return { __esModule: true, default: jest.fn(() => instance), instance };
});
jest.mock('../../src/models/Payment.model', () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    aggregate: jest.fn(),
  },
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(() => ({ select: () => Promise.resolve(null) })) },
}));
jest.mock('../../src/services/referral.service', () => ({
  __esModule: true,
  default: { processPaymentReward: jest.fn() },
}));
jest.mock('../../src/services/membership.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: jest.fn(() => Promise.resolve()), logFinancialActivity: jest.fn() },
}));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null, emitToUser: jest.fn() }));
jest.mock('../../src/socket/supraspace.socket', () => ({ getIO: () => null }));
jest.mock('../../src/utils/safeNotification', () => ({
  safeCreateNotification: jest.fn(),
  notifyOrgAdmins: jest.fn(),
}));

import paymentController from '../../src/controllers/payment.controller';
import Payment from '../../src/models/Payment.model';
import ReferralService from '../../src/services/referral.service';
import activityService from '../../src/services/activity.service';
import { safeCreateNotification } from '../../src/utils/safeNotification';

const stripe = (jest.requireMock('stripe') as { instance: any }).instance;
const payments = Payment as unknown as Record<string, jest.Mock>;
const NOT_DONE = { $nin: ['succeeded', 'refunded'] };

/** Runs a controller and waits for what it answers (or the error it passes on). */
function call(handler: any, req: Record<string, unknown>): Promise<{ res: any; error: any }> {
  return new Promise((resolve) => {
    const res: any = { statusCode: 200 };
    res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
    res.json = jest.fn((body: unknown) => { res.body = body; resolve({ res, error: undefined }); return res; });
    handler({ headers: {}, params: {}, body: {}, ...req }, res, (error: unknown) => resolve({ res, error }));
  });
}

const invoice = (overrides: Record<string, unknown> = {}) => ({
  _id: 'pay-1',
  amount: 25,
  status: 'processing',
  customerName: 'Test Customer',
  customerEmail: 'customer@example.com',
  organizationId: 'org-1',
  createdBy: 'staff-1',
  save: jest.fn(),
  ...overrides,
});

const stripeUpdate = (event: unknown) => {
  stripe.webhooks.constructEvent.mockReturnValue(event);
  return call(paymentController.handleStripeWebhook, { headers: { 'stripe-signature': 'sig' }, rawBody: '{}' });
};

beforeEach(() => {
  jest.clearAllMocks();
  stripe.paymentIntents.retrieve.mockResolvedValue({ id: 'pi_1', latest_charge: 'ch_1', status: 'succeeded' });
  stripe.charges.retrieve.mockResolvedValue({ receipt_url: 'https://receipt.example', payment_method_details: { type: 'card' } });
});

// ─── A payment is marked paid, and followed up, exactly once ───────────────
describe('a payment is marked paid exactly once', () => {
  const checkoutPaid = {
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', metadata: { paymentId: 'pay-1' } } },
  };

  it('marks a paid checkout as paid with its receipt, and follows up once', async () => {
    payments.findOneAndUpdate.mockResolvedValueOnce(invoice({ status: 'succeeded' }));
    const { res } = await stripeUpdate(checkoutPaid);

    expect(res.body).toEqual({ received: true });
    const [filter, update] = payments.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'pay-1', status: NOT_DONE });
    expect(update.$set).toMatchObject({
      status: 'succeeded',
      stripeCheckoutSessionId: 'cs_1',
      stripePaymentIntentId: 'pi_1',
      stripeChargeId: 'ch_1',
      receiptUrl: 'https://receipt.example',
      paymentMethod: 'card',
    });
    expect(safeCreateNotification).toHaveBeenCalledTimes(1);
    expect(ReferralService.processPaymentReward).toHaveBeenCalledTimes(1);
    expect(activityService.createActivity).toHaveBeenCalledTimes(1);
  });

  it('tells the staff member even when the customer coming back marks it paid first', async () => {
    payments.findById.mockResolvedValueOnce(invoice());
    payments.findOneAndUpdate.mockResolvedValueOnce(invoice({ status: 'succeeded' }));
    stripe.checkout.sessions.retrieve.mockResolvedValue({
      id: 'cs_1', status: 'complete', payment_status: 'paid', payment_intent: 'pi_1', metadata: { paymentId: 'pay-1' },
    });
    const { res } = await call(paymentController.getCheckoutSessionStatus, {
      params: { sessionId: 'cs_1' },
      user: { _id: 'customer-1', email: 'customer@example.com' },
    });
    expect(res.body.data.status).toBe('succeeded');
    expect(safeCreateNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'staff-1', title: 'Payment Received' }));

    // Stripe's update arriving afterwards finds it already paid and adds nothing.
    payments.findOneAndUpdate.mockResolvedValueOnce(null);
    await stripeUpdate(checkoutPaid);
    expect(safeCreateNotification).toHaveBeenCalledTimes(1);
  });

  it('does nothing more when Stripe reports the same payment again', async () => {
    payments.findOneAndUpdate.mockResolvedValue(null); // already marked paid
    await stripeUpdate(checkoutPaid);
    await stripeUpdate({ type: 'payment_intent.succeeded', data: { object: { id: 'pi_1', latest_charge: 'ch_1' } } });

    expect(safeCreateNotification).not.toHaveBeenCalled();
    expect(ReferralService.processPaymentReward).not.toHaveBeenCalled();
    expect(activityService.createActivity).not.toHaveBeenCalled();
  });

  it('ignores a checkout that Stripe has not been paid for', async () => {
    await stripeUpdate({ ...checkoutPaid, data: { object: { ...checkoutPaid.data.object, payment_status: 'unpaid' } } });
    expect(payments.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('never marks a paid or refunded invoice as failed', async () => {
    await stripeUpdate({
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_1', last_payment_error: { message: 'Your card was declined.' } } },
    });
    expect(payments.findOneAndUpdate).toHaveBeenCalledWith(
      { stripePaymentIntentId: 'pi_1', status: { $nin: ['succeeded', 'refunded', 'cancelled'] } },
      { $set: { status: 'failed', failureReason: 'Your card was declined.' } },
      { new: true },
    );
  });

  it('records a refund from the Stripe dashboard against the right invoice', async () => {
    await stripeUpdate({
      type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_1', amount_refunded: 1000, refunded: false } },
    });
    const [filter, update] = payments.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ stripePaymentIntentId: 'pi_1' });
    expect(update.$max).toEqual({ refundedAmount: 10 });
  });

  it('refuses an update that is not signed by Stripe', async () => {
    stripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('bad signature'); });
    const { error } = await call(paymentController.handleStripeWebhook, { headers: { 'stripe-signature': 'x' }, rawBody: '{}' });
    expect(error?.statusCode).toBe(400);
    expect(payments.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('does not cancel an invoice that got paid while the customer was cancelling', async () => {
    payments.findById
      .mockResolvedValueOnce(invoice({ status: 'pending' }))
      .mockResolvedValueOnce(invoice({ status: 'succeeded' }));
    payments.findOneAndUpdate.mockResolvedValueOnce(null); // paid in the meantime
    const { error } = await call(paymentController.cancelMyPayment, {
      params: { id: 'pay-1' },
      user: { email: 'customer@example.com' },
    });
    expect(error?.statusCode).toBe(409);
  });
});
