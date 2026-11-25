/**
 * Suprah Pay batch 3 (2026-11-20), one section per fix. Stripe, the database
 * and notifications are stand-ins: nothing here talks to Stripe or a database.
 */
jest.mock('stripe', () => {
  const instance = {
    webhooks: { constructEvent: jest.fn() },
    paymentIntents: { retrieve: jest.fn(), create: jest.fn(), cancel: jest.fn() },
    charges: { retrieve: jest.fn() },
    customers: { list: jest.fn(), create: jest.fn(), retrieve: jest.fn((id: string) => Promise.resolve({ id })) },
    checkout: { sessions: { retrieve: jest.fn(), create: jest.fn(), expire: jest.fn() } },
  };
  return { __esModule: true, default: jest.fn(() => instance), instance };
});
// SuprahPay settings (2026-11-21): the defaults (no stored settings).
jest.mock('../../src/models/SystemConfig.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve(null) }) })) },
}));
jest.mock('../../src/models/Payment.model', () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: jest.fn(),
    findByIdAndUpdate: jest.fn(),
    findById: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    aggregate: jest.fn(),
    countDocuments: jest.fn(),
  },
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(() => ({ select: () => Promise.resolve(null) })),
    find: jest.fn(),
    countDocuments: jest.fn(),
  },
}));
// The super admin screens' searches (admin.controller) load these.
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { find: jest.fn(), countDocuments: jest.fn(), findById: jest.fn() },
}));
jest.mock('../../src/models/AuditLog.model', () => ({
  __esModule: true,
  default: { find: jest.fn(), countDocuments: jest.fn() },
}));
jest.mock('../../src/models/SystemLog.model', () => ({
  SystemLog: { find: jest.fn(), countDocuments: jest.fn() },
}));
jest.mock('../../src/models/SyncLog.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/DriverProfile.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/DriverTrackingDevice.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/metrics', () => ({
  metrics: {}, getPercentile: jest.fn(), driverTrackerMetrics: {}, connectionMetrics: {},
}));
jest.mock('../../src/services/traccar.service', () => ({ traccarHealthSnapshot: jest.fn() }));
jest.mock('../../src/services/googleGeocoding.service', () => ({ googleGeocodingHealthSnapshot: jest.fn() }));
jest.mock('../../src/services/activeOrganizations.service', () => ({ invalidateActiveOrganizations: jest.fn() }));
jest.mock('../../src/utils/cache.util', () => ({ invalidateUserCache: jest.fn() }));
jest.mock('pidusage', () => jest.fn());
// Plan changes (organization.controller) load these too.
jest.mock('../../src/models/Load.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/trayDevice.service', () => ({ revokeTrayDevicesForEmail: jest.fn() }));
jest.mock('../../src/services/referral.service', () => ({
  __esModule: true,
  default: { processPaymentReward: jest.fn() },
}));
jest.mock('../../src/services/membership.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: jest.fn(() => Promise.resolve()), logFinancialActivity: jest.fn() },
}));
jest.mock('../../src/utils/socketEmitter', () => ({
  getSocketIO: () => null, emitToUser: jest.fn(), disconnectUserSockets: jest.fn(),
}));
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
import { notifyOrgAdmins } from '../../src/utils/safeNotification';
import { KEPT_AMOUNT, disputeOutcome, keptAmount } from '../../src/utils/paymentDispute';

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
      data: { object: { id: 'pi_1', last_payment_error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } } },
    });
    expect(payments.findOneAndUpdate).toHaveBeenCalledWith(
      { stripePaymentIntentId: 'pi_1', status: { $nin: ['succeeded', 'refunded', 'cancelled'] } },
      { $set: { status: 'failed', failureReason: "The card was declined, so nothing was charged. Try another card, or contact the card's bank." } },
      { new: true },
    );
  });

  it('records a refund from the Stripe dashboard against the right invoice', async () => {
    await stripeUpdate({
      type: 'charge.refunded',
      data: { object: { payment_intent: 'pi_1', amount_refunded: 1000, refunded: false } },
    });
    const [filter, update] = payments.findOneAndUpdate.mock.calls[0];
    // Only a refund that raises the total is recorded and announced (2026-11-25).
    expect(filter).toMatchObject({ stripePaymentIntentId: 'pi_1' });
    expect(filter.$or).toContainEqual({ refundedAmount: { $lt: 10 } });
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

// ─── Leaving Stripe's payment page puts the invoice back under "To pay" ─────
describe("leaving Stripe's payment page", () => {
  const customer = { _id: 'customer-1', email: 'customer@example.com' };
  const earlierPage = (overrides: Record<string, unknown> = {}) => ({
    id: 'cs_old', status: 'open', payment_status: 'unpaid', payment_intent: null, ...overrides,
  });
  const leave = () => call(paymentController.leaveCheckout, { params: { id: 'pay-1' }, user: customer });

  it('closes the open Stripe page and puts the invoice back under To pay', async () => {
    payments.findById.mockResolvedValueOnce(invoice({ stripeCheckoutSessionId: 'cs_old' }));
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce(earlierPage());
    stripe.checkout.sessions.expire.mockResolvedValueOnce(earlierPage({ status: 'expired' }));
    payments.findOneAndUpdate.mockResolvedValueOnce(invoice({ status: 'pending' }));

    const { res } = await leave();
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_old');
    expect(payments.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'pay-1', status: 'processing' },
      { $set: { status: 'pending' } },
      { new: true },
    );
    expect(res.body.data.status).toBe('pending');
  });

  it('marks it paid instead when Stripe says the page was paid after all', async () => {
    payments.findById.mockResolvedValueOnce(invoice({ stripeCheckoutSessionId: 'cs_old' }));
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce(
      earlierPage({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_1' }),
    );
    payments.findOneAndUpdate.mockResolvedValueOnce(invoice({ status: 'succeeded' }));

    const { res } = await leave();
    expect(res.body.data.status).toBe('succeeded');
    expect(stripe.checkout.sessions.expire).not.toHaveBeenCalled();
    expect(safeCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("can't change another customer's invoice", async () => {
    payments.findById.mockResolvedValueOnce(invoice({ customerEmail: 'someone@example.com', stripeCheckoutSessionId: 'cs_old' }));
    const { error } = await leave();
    expect(error?.statusCode).toBe(403);
    expect(stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
  });

  const pay = () =>
    call(paymentController.createCustomerCheckoutSession, { body: { paymentId: 'pay-1' }, user: customer });

  it('Pay closes the earlier page before opening a new one', async () => {
    payments.findById.mockResolvedValueOnce(invoice({ stripeCheckoutSessionId: 'cs_old', stripeCustomerId: 'cus_1' }));
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce(earlierPage());
    stripe.checkout.sessions.expire.mockResolvedValueOnce(earlierPage({ status: 'expired' }));
    stripe.checkout.sessions.create.mockResolvedValueOnce({ id: 'cs_new', url: 'https://checkout.example/cs_new' });
    payments.findOneAndUpdate.mockResolvedValueOnce(invoice({ status: 'processing', stripeCheckoutSessionId: 'cs_new' }));

    const { res } = await pay();
    expect(stripe.checkout.sessions.expire.mock.invocationCallOrder[0])
      .toBeLessThan(stripe.checkout.sessions.create.mock.invocationCallOrder[0]);
    expect(stripe.checkout.sessions.create.mock.calls[0][0].cancel_url).toMatch(/status=cancelled&invoice=pay-1$/);
    expect(res.body.data.url).toBe('https://checkout.example/cs_new');
  });

  it('Pay never opens a second page for an invoice that was already paid', async () => {
    payments.findById.mockResolvedValueOnce(invoice({ stripeCheckoutSessionId: 'cs_old' }));
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce(
      earlierPage({ status: 'complete', payment_status: 'paid', payment_intent: 'pi_1' }),
    );
    payments.findOneAndUpdate.mockResolvedValueOnce(invoice({ status: 'succeeded' }));

    const { error } = await pay();
    expect(error?.statusCode).toBe(409);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("says to try again if Stripe's earlier page couldn't be closed", async () => {
    payments.findById.mockResolvedValueOnce(invoice({ stripeCheckoutSessionId: 'cs_old' }));
    stripe.checkout.sessions.retrieve.mockResolvedValue(earlierPage());
    stripe.checkout.sessions.expire.mockRejectedValueOnce(new Error('Stripe is busy'));

    const { error } = await pay();
    expect(error?.statusCode).toBe(409);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("puts the invoice back when Stripe's page expires unpaid (only its latest page)", async () => {
    await stripeUpdate({ type: 'checkout.session.expired', data: { object: { id: 'cs_old', metadata: { paymentId: 'pay-1' } } } });
    expect(payments.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'pay-1', stripeCheckoutSessionId: 'cs_old', status: 'processing' },
      { $set: { status: 'pending' } },
    );
  });
});

// ─── Card disputes (chargebacks) ────────────────────────────────────────────
describe('card disputes', () => {
  it("reads Stripe's dispute status in Suprah's terms", () => {
    expect(['needs_response', 'under_review', 'warning_needs_response', 'warning_under_review'].map(disputeOutcome))
      .toEqual(['open', 'open', 'open', 'open']);
    expect(['won', 'warning_closed', 'prevented'].map(disputeOutcome)).toEqual(['won', 'won', 'won']);
    expect(disputeOutcome('lost')).toBe('lost');
  });

  it('keeps counting a disputed payment until the bank decides, and leaves out a lost one like a refund', () => {
    expect(keptAmount({ amount: 25, disputeStatus: 'open', disputedAmount: 25 })).toBe(25);
    expect(keptAmount({ amount: 25, disputeStatus: 'won', disputedAmount: 25 })).toBe(25);
    expect(keptAmount({ amount: 25, disputeStatus: 'lost', disputedAmount: 25 })).toBe(0);
    expect(keptAmount({ amount: 25, refundedAmount: 10, disputeStatus: 'lost', disputedAmount: 15 })).toBe(0);
    expect(keptAmount({ amount: 25, refundedAmount: 10 })).toBe(15);
    expect(keptAmount({ amount: 25, refundedAmount: 20, disputeStatus: 'lost', disputedAmount: 25 })).toBe(0);
  });

  const disputeUpdate = (type: string, status: string) =>
    stripeUpdate({
      type,
      data: { object: { id: 'dp_1', status, amount: 2500, reason: 'fraudulent', payment_intent: 'pi_1', charge: 'ch_1' } },
    });

  it('records a new dispute on its invoice and tells the dealership admins once', async () => {
    payments.findOneAndUpdate.mockResolvedValueOnce(invoice({ status: 'succeeded', invoiceNumber: 'INV-1' }));
    await disputeUpdate('charge.dispute.created', 'needs_response');

    const [filter, update, options] = payments.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ $or: [{ stripePaymentIntentId: 'pi_1' }, { stripeChargeId: 'ch_1' }] });
    expect(update.$set).toMatchObject({ stripeDisputeId: 'dp_1', disputeStatus: 'open', disputedAmount: 25, disputeReason: 'fraudulent' });
    expect(options).toEqual({ new: false });
    expect(notifyOrgAdmins).toHaveBeenCalledWith(
      'org-1',
      'payment_failed',
      'Payment disputed',
      "Test Customer's payment for invoice INV-1 ($25.00) was disputed with their bank. It still counts in your revenue while the bank reviews it.",
      { paymentId: 'pay-1', disputeStatus: 'open', route: '/billing/payments' },
    );

    // Stripe telling the same thing again (e.g. evidence added) tells nobody twice.
    payments.findOneAndUpdate.mockResolvedValueOnce(invoice({ status: 'succeeded', stripeDisputeId: 'dp_1', disputeStatus: 'open' }));
    await disputeUpdate('charge.dispute.updated', 'under_review');
    expect(notifyOrgAdmins).toHaveBeenCalledTimes(1);
  });

  it("tells the admins when the bank decides, and a lost dispute is closed out", async () => {
    payments.findOneAndUpdate.mockResolvedValueOnce(invoice({ status: 'succeeded', stripeDisputeId: 'dp_1', disputeStatus: 'open' }));
    await disputeUpdate('charge.dispute.closed', 'lost');
    const [, update] = payments.findOneAndUpdate.mock.calls[0];
    expect(update.$set).toMatchObject({ disputeStatus: 'lost' });
    expect(update.$set.disputeClosedAt).toBeInstanceOf(Date);
    expect((notifyOrgAdmins as jest.Mock).mock.calls[0][2]).toBe('Dispute lost');
  });

  it('ignores a dispute for a payment Suprah does not know', async () => {
    payments.findOneAndUpdate.mockResolvedValueOnce(null);
    await disputeUpdate('charge.dispute.created', 'needs_response');
    expect(notifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('every revenue total uses the money kept (refunds and lost disputes left out)', async () => {
    payments.aggregate.mockResolvedValue([]);
    await call(paymentController.getPaymentStats, { orgId: 'org-1' });
    const [byStatus, monthly] = payments.aggregate.mock.calls.map((c) => c[0]);
    expect(byStatus[1].$group.keptAmount).toEqual({ $sum: KEPT_AMOUNT });
    expect(monthly[1].$group.revenue).toEqual({ $sum: KEPT_AMOUNT });

    payments.aggregate.mockClear();
    await call(paymentController.getBillingBalance, { orgId: 'org-1' });
    expect(payments.aggregate.mock.calls[0][0][1].$group.balance).toEqual({ $sum: KEPT_AMOUNT });
  });
});

// ─── Follow-up fixes (2026-11-20) ────────────────────────────────────────────
import * as adminController from '../../src/controllers/admin.controller';
import Organization from '../../src/models/Organization.model';
import User from '../../src/models/User.model';
import AuditLog from '../../src/models/AuditLog.model';
import { SystemLog } from '../../src/models/SystemLog.model';

/** A stand-in database query: any chain of sort/skip/limit/select/populate/lean, answering `rows`. */
function query(rows: unknown[] = []) {
  const q: any = {};
  for (const step of ['sort', 'skip', 'limit', 'select', 'populate', 'lean']) q[step] = jest.fn(() => q);
  q.then = (done: (v: unknown) => unknown, failed: (e: unknown) => unknown) => Promise.resolve(rows).then(done, failed);
  return q;
}

describe('searches treat typed text as plain text', () => {
  const tricky = 'a(b+';

  it('the Payments search and payment-method filter match special characters literally', async () => {
    payments.find.mockReturnValue(query());
    payments.countDocuments.mockResolvedValue(0);
    payments.aggregate.mockResolvedValue([]);

    const { error } = await call(paymentController.getPayments, {
      orgId: 'org-1',
      query: { search: `  ${tricky} `, paymentMethod: 'card(' },
    });

    expect(error).toBeUndefined();
    const filter = payments.find.mock.calls.at(-1)[0];
    expect(filter.organizationId).toBe('org-1');
    const byName: RegExp = filter.$or[0].customerName;
    expect(byName.test('Invoice for a(b+ c')).toBe(true);
    expect(byName.test('aab')).toBe(false);
    expect(filter.paymentMethod.test('Card(visa)')).toBe(true);
  });

  it('a search that is only spaces is ignored', async () => {
    payments.find.mockReturnValue(query());
    payments.countDocuments.mockResolvedValue(0);
    payments.aggregate.mockResolvedValue([]);
    await call(paymentController.getPayments, { orgId: 'org-1', query: { search: '   ' } });
    expect(payments.find.mock.calls.at(-1)[0].$or).toBeUndefined();
  });

  const literal = (pattern: string) => new RegExp(pattern, 'i');

  it('super admin Organizations and Users searches', async () => {
    (Organization.find as jest.Mock).mockReturnValue(query());
    (Organization.countDocuments as jest.Mock).mockResolvedValue(0);
    (User.find as jest.Mock).mockReturnValue(query());
    (User.countDocuments as jest.Mock).mockResolvedValue(0);

    await call(adminController.getAllOrganizations, { query: { search: tricky } });
    await call(adminController.getAllUsers, { query: { search: tricky } });

    const orgFilter = (Organization.find as jest.Mock).mock.calls.at(-1)[0];
    expect(literal(orgFilter.name.$regex).test('Dealer a(b+')).toBe(true);
    const userFilter = (User.find as jest.Mock).mock.calls.at(-1)[0];
    expect(literal(userFilter.$or[1].email.$regex).test('a(b+@example.com')).toBe(true);
  });

  it('super admin Logs and Audit logs searches', async () => {
    (SystemLog.find as jest.Mock).mockReturnValue(query());
    (SystemLog.countDocuments as jest.Mock).mockResolvedValue(0);
    (AuditLog.find as jest.Mock).mockReturnValue(query());
    (AuditLog.countDocuments as jest.Mock).mockResolvedValue(0);

    const longText = 'payment failed (card declined) + retry';
    const { error } = await call(adminController.getSystemLogs, { query: { search: longText } });
    await call(adminController.getAuditLogs, { query: { search: tricky } });

    expect(error).toBeUndefined();
    const logFilter = (SystemLog.find as jest.Mock).mock.calls.at(-1)[0];
    expect(literal(logFilter.$or[2].message.$regex).test(`x ${longText} y`)).toBe(true);
    const auditFilter = (AuditLog.find as jest.Mock).mock.calls.at(-1)[0];
    expect(literal(auditFilter.reason.$regex).test('reason a(b+')).toBe(true);
  });
});

describe("an invoice's status can't be set by hand", () => {
  it('refuses to change the status and pays no referral reward', async () => {
    const draft = invoice({ status: 'pending' });
    payments.findOne.mockResolvedValue(draft);
    (ReferralService.processPaymentReward as jest.Mock).mockClear();

    const { error } = await call(paymentController.updatePayment, {
      orgId: 'org-1', params: { id: 'pay-1' }, body: { status: 'succeeded' },
    });

    expect(error?.statusCode).toBe(400);
    expect(draft.status).toBe('pending');
    expect(draft.save).not.toHaveBeenCalled();
    expect(ReferralService.processPaymentReward).not.toHaveBeenCalled();
  });

  it('still saves notes and the due date (sending the current status back is fine)', async () => {
    const draft: any = invoice({ status: 'pending' });
    payments.findOne.mockResolvedValue(draft);

    const { error } = await call(paymentController.updatePayment, {
      orgId: 'org-1', params: { id: 'pay-1' },
      body: { status: 'pending', notes: 'Call before Friday', dueDate: '2026-12-01' },
    });

    expect(error).toBeUndefined();
    expect(draft.notes).toBe('Call before Friday');
    expect(draft.dueDate.toISOString().slice(0, 10)).toBe('2026-12-01');
    expect(draft.save).toHaveBeenCalled();
  });

  it('turns away a due date that is not a date', async () => {
    const draft = invoice({ status: 'pending' });
    payments.findOne.mockResolvedValue(draft);
    const { error } = await call(paymentController.updatePayment, {
      orgId: 'org-1', params: { id: 'pay-1' }, body: { dueDate: 'next week-ish' },
    });
    expect(error?.statusCode).toBe(400);
    expect(draft.save).not.toHaveBeenCalled();
  });
});

import { updateOwnOrganizationSubscription } from '../../src/controllers/organization.controller';

describe('only Suprah super admins change a dealership plan', () => {
  const orgs = Organization as unknown as Record<string, jest.Mock>;
  const dealership = () => ({
    _id: 'org-1', name: 'Test Motors', ownerId: 'owner-1',
    subscription: { tier: 'suprah_go', status: 'active' },
    save: jest.fn(),
  });

  it("turns away the dealership's own admin and owner, without loading the dealership", async () => {
    orgs.findById.mockClear();
    for (const user of [{ _id: 'admin-1', role: 'admin' }, { _id: 'owner-1', role: 'admin' }]) {
      const { error } = await call(updateOwnOrganizationSubscription, {
        user, orgId: 'org-1', orgRole: 'admin',
        params: { id: 'org-1' }, body: { tier: 'suprah_premium_ultra' },
      });
      expect(error?.statusCode).toBe(403);
      expect(error?.message).toMatch(/Ask your Suprah contact/);
    }
    expect(orgs.findById).not.toHaveBeenCalled();
  });

  it('a super admin can still change it', async () => {
    const org = dealership();
    orgs.findById.mockResolvedValue(org);
    const { error, res } = await call(updateOwnOrganizationSubscription, {
      user: { _id: 'sa-1', role: 'super_admin' },
      params: { id: 'org-1' }, body: { tier: 'suprah_premium' },
    });
    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(org.subscription.tier).toBe('suprah_premium');
    expect(org.save).toHaveBeenCalled();
  });
});

import { customerInvoiceView } from '../../src/utils/customerPayments';

describe('customers receive only the invoice details their screens show', () => {
  const stored = {
    _id: 'pay-9', invoiceNumber: 'INV-2026-11-0009', description: 'Carwash package',
    amount: 20, status: 'succeeded', currency: 'usd', lineItems: [{ label: 'Carwash', quantity: 1, unitPrice: 20, lineTotal: 20 }],
    receiptUrl: 'https://pay.stripe.com/receipts/test', refundedAmount: 0, createdAt: '2026-11-20T00:00:00.000Z',
    customerName: 'Test Customer', customerEmail: 'customer@example.com',
    // Dealership-side details:
    notes: 'Created from CRM lead 123', createdBy: 'staff-1', organizationId: 'org-1',
    stripeCustomerId: 'cus_test', stripePaymentIntentId: 'pi_test', stripeCheckoutSessionId: 'cs_test',
    failureReason: 'card_declined', disputeStatus: 'lost', disputedAmount: 5,
  };
  const HIDDEN = ['notes', 'createdBy', 'organizationId', 'stripeCustomerId', 'stripePaymentIntentId',
    'stripeCheckoutSessionId', 'failureReason', 'disputeStatus', 'disputedAmount'];

  it('the Suprah Pay list leaves out staff notes and internal references, and totals still count disputes', async () => {
    const list = query([stored]);
    payments.find.mockReturnValue(list);

    const { res } = await call(paymentController.getMyPaymentsAsCustomer, { user: { email: 'Customer@Example.com' } });

    const sent = res.body.data.payments[0];
    for (const field of HIDDEN) expect(sent).not.toHaveProperty(field);
    expect(sent).toMatchObject({ invoiceNumber: 'INV-2026-11-0009', amount: 20, status: 'succeeded', receiptUrl: stored.receiptUrl });
    expect(res.body.data.stats.totalPaid).toBe(15); // $20 less the $5 dispute that was lost
    expect(list.select.mock.calls[0][0]).toContain('disputedAmount');
    expect(list.select.mock.calls[0][0]).not.toContain('notes');
  });

  it('the cancel and return-from-Stripe answers use the same view', async () => {
    payments.findById.mockResolvedValue({ ...stored, status: 'cancelled', toObject() { return { ...stored, status: 'cancelled' }; } });
    const { res } = await call(paymentController.cancelMyPayment, {
      user: { email: 'customer@example.com' }, params: { id: 'pay-9' },
    });
    expect(res.body.data.status).toBe('cancelled');
    for (const field of HIDDEN) expect(res.body.data).not.toHaveProperty(field);
    expect(customerInvoiceView(null)).toBeNull();
  });
});

import linkedAccountService from '../../src/services/linkedAccount.service';
import { WISE_NOT_SET_UP_MESSAGE, wiseSettingsFrom, wiseSetupProblem } from '../../src/utils/wiseSettings';

describe('the Wise link check has no built-in key', () => {
  const saved = process.env.LINKED_ACCOUNT_STATE_SECRET;
  afterEach(() => {
    if (saved === undefined) delete process.env.LINKED_ACCOUNT_STATE_SECRET;
    else process.env.LINKED_ACCOUNT_STATE_SECRET = saved;
  });

  it('without the setting, Wise counts as not set up and no link check can be made or accepted', () => {
    delete process.env.LINKED_ACCOUNT_STATE_SECRET;
    const settings = wiseSettingsFrom({
      NODE_ENV: 'development', WISE_CLIENT_ID: 'c', WISE_CLIENT_SECRET: 's', WISE_REDIRECT_URI: 'http://localhost/cb',
    });
    expect(wiseSetupProblem(settings)).toBe('missing Wise settings: LINKED_ACCOUNT_STATE_SECRET');
    expect(() => linkedAccountService.signState('user-1', 'wise')).toThrow(WISE_NOT_SET_UP_MESSAGE);

    // A check made with some other key (for example one copied from old code) is turned away.
    process.env.LINKED_ACCOUNT_STATE_SECRET = 'someone-elses-key';
    const forged = linkedAccountService.signState('user-2', 'wise');
    delete process.env.LINKED_ACCOUNT_STATE_SECRET;
    expect(linkedAccountService.verifyState(forged)).toBeNull();
  });

  it('with the setting, a link check made here is accepted and one signed with another key is not', () => {
    process.env.LINKED_ACCOUNT_STATE_SECRET = 'other-key';
    const forged = linkedAccountService.signState('user-2', 'wise');
    process.env.LINKED_ACCOUNT_STATE_SECRET = 'this-server-key';
    const state = linkedAccountService.signState('user-1', 'wise');
    expect(linkedAccountService.verifyState(state)).toEqual({ userId: 'user-1', provider: 'wise' });
    expect(linkedAccountService.verifyState(forged)).toBeNull();
  });
});

import { customerNoteFrom, invoiceLinesFrom, taxRateFrom } from '../../src/utils/invoiceLines';

describe('invoice lines: items and discounts', () => {
  it('an item costs quantity × price and a discount takes its amount off', () => {
    const result = invoiceLinesFrom([
      { label: ' Carwash package ', kind: 'product', quantity: 2, unitPrice: 20 },
      { label: 'Service fee', kind: 'fee', quantity: 1, unitPrice: 4.995 },
      { label: '', kind: 'discount', quantity: 1, unitPrice: 5 },
    ]);
    expect(result).toEqual({
      ok: true,
      subtotal: 40,
      lines: [
        { label: 'Carwash package', kind: 'product', quantity: 2, unitPrice: 20, lineTotal: 40 },
        { label: 'Service fee', kind: 'fee', quantity: 1, unitPrice: 5, lineTotal: 5 },
        { label: 'Discount', kind: 'discount', quantity: 1, unitPrice: 5, lineTotal: -5 },
      ],
    });
  });

  it('turns away lines that would make a confusing or wrong invoice', () => {
    expect(invoiceLinesFrom([])).toEqual({ ok: false, message: 'Add at least one item to the invoice.' });
    expect(invoiceLinesFrom([{ label: 'Wash', quantity: 0, unitPrice: 20 }])).toEqual({
      ok: false, message: 'Line 1: enter a quantity greater than 0.',
    });
    // A negative price used to slip a hidden discount onto an item line.
    expect(invoiceLinesFrom([{ label: 'Wash', quantity: 1, unitPrice: -20 }])).toEqual({
      ok: false, message: 'Line 1: enter a price of $0 or more.',
    });
    expect(invoiceLinesFrom([{ label: 'Wash', kind: 'gift', quantity: 1, unitPrice: 1 }])).toEqual({
      ok: false, message: 'Line 1 has an unknown type.',
    });
    expect(invoiceLinesFrom([{ label: 'Wash', quantity: 1, unitPrice: 1_000_000 }]).ok).toBe(false);
  });

  it('tax must be 0–100% and the note to the customer is text up to 1,000 characters', () => {
    expect(taxRateFrom('8.25')).toBe(8.25);
    expect(taxRateFrom(undefined)).toBe(0);
    expect(taxRateFrom(-1)).toBeNull();
    expect(taxRateFrom(101)).toBeNull();
    expect(customerNoteFrom('  Pick up after 3pm.  ')).toBe('Pick up after 3pm.');
    expect(customerNoteFrom('   ')).toBeUndefined();
    expect(customerNoteFrom({ $ne: null })).toBeNull();
    expect(customerNoteFrom('x'.repeat(1001))).toBeNull();
  });

  it("the customer receives the dealership's note to them, but not its internal notes", () => {
    const view = customerInvoiceView({ amount: 20, customerNote: 'Pick up after 3pm.', notes: 'VIP, call first' });
    expect(view).toEqual({ amount: 20, customerNote: 'Pick up after 3pm.' });
  });
});
