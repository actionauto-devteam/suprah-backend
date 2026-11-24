/**
 * SuprahPay decisions batch (2026-11-21): payment rules in the real payment
 * controller (batch-2026-11-21.test.ts replaces the controller to test who
 * gets through, so these live here). Stripe, the database and notifications
 * are stand-ins.
 */
jest.mock('stripe', () => {
  const instance = {
    webhooks: { constructEvent: jest.fn() },
    paymentIntents: { retrieve: jest.fn(), create: jest.fn(), cancel: jest.fn() },
    charges: { retrieve: jest.fn() },
    customers: { list: jest.fn(), create: jest.fn(), retrieve: jest.fn((id: string) => Promise.resolve({ id })) },
    checkout: { sessions: { retrieve: jest.fn(), create: jest.fn(), expire: jest.fn() } },
    accounts: { retrieve: jest.fn(), create: jest.fn() },
    accountLinks: { create: jest.fn() },
    transfers: { create: jest.fn() },
    refunds: { create: jest.fn() },
  };
  return { __esModule: true, default: jest.fn(() => instance), instance };
});
jest.mock('../../src/models/Payment.model', () => ({
  __esModule: true,
  default: { create: jest.fn(), findOne: jest.fn(), findById: jest.fn(), findByIdAndUpdate: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn(), aggregate: jest.fn() },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../../src/models/DealershipPayout.model', () => ({
  __esModule: true,
  default: { aggregate: jest.fn(), create: jest.fn(), updateOne: jest.fn(() => Promise.resolve()), findById: jest.fn(), find: jest.fn() },
}));
jest.mock('../../src/models/AuditLog.model', () => ({ __esModule: true, default: { create: jest.fn(() => Promise.resolve()) } }));
jest.mock('../../src/models/SystemConfig.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findOne: jest.fn(), findById: jest.fn() } }));
jest.mock('../../src/services/referral.service', () => ({ __esModule: true, default: { processPaymentReward: jest.fn() } }));
jest.mock('../../src/services/membership.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: jest.fn(() => Promise.resolve()), logFinancialActivity: jest.fn() },
}));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null, emitToUser: jest.fn(), streamLogToAdmins: jest.fn() }));
jest.mock('../../src/socket/supraspace.socket', () => ({ getIO: () => null }));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: jest.fn(), notifyOrgAdmins: jest.fn() }));
// Deleting a dealership first checks for loads with a driver on them (2026-11-23 tests).
jest.mock('../../src/models/Load.model', () => ({ __esModule: true, default: { find: jest.fn() } }));

import paymentController from '../../src/controllers/payment.controller';
import Payment from '../../src/models/Payment.model';
import Organization from '../../src/models/Organization.model';
import SystemConfig from '../../src/models/SystemConfig.model';
import User from '../../src/models/User.model';
import logger from '../../src/utils/logger';
import { safeCreateNotification } from '../../src/utils/safeNotification';
import { clearPlatformSettingsCache, paymentLimitProblem } from '../../src/services/suprahPaySettings.service';
import { paymentPurposeFrom } from '../../src/utils/paymentPurpose';
import { statementSuffixFor } from '../../src/utils/paymentBranding';

const stripe = (jest.requireMock('stripe') as { instance: any }).instance;
const payments = Payment as unknown as Record<string, jest.Mock>;
const orgs = Organization as unknown as Record<string, jest.Mock>;
const configs = SystemConfig as unknown as Record<string, jest.Mock>;

const ORG_ID = '64b7f0c2a1b2c3d4e5f60718';
const STAFF = { _id: 'staff-1', role: 'employee', name: 'Sam' };

function call(handler: any, req: Record<string, unknown>): Promise<{ res: any; error: any }> {
  return new Promise((resolve) => {
    const res: any = { statusCode: 200 };
    res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
    res.json = jest.fn((body: unknown) => { res.body = body; resolve({ res, error: undefined }); return res; });
    handler({ headers: {}, params: {}, body: {}, query: {}, ...req }, res, (error: unknown) => resolve({ res, error }));
  });
}
const lean = (value: unknown) => {
  const q: any = {};
  for (const step of ['select', 'populate', 'sort', 'limit']) q[step] = jest.fn(() => q);
  q.lean = jest.fn(() => Promise.resolve(value));
  return q;
};

/** The dealership and Suprah's settings for a test. */
function dealership(fields: Record<string, unknown> = {}, platform: Record<string, unknown> | null = null) {
  orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', subscription: { tier: 'suprah_origin' }, ...fields }));
  configs.findOne.mockReturnValue(lean(platform ? { value: platform } : null));
}

beforeEach(() => {
  jest.clearAllMocks();
  clearPlatformSettingsCache();
  payments.create.mockImplementation((doc: any) => Promise.resolve({ _id: 'pay-1', ...doc }));
});

const request = (body: Record<string, unknown>) =>
  call(paymentController.createPayment, { user: STAFF, orgId: ORG_ID, body });
const valid = { customerName: 'Pat Lee', customerEmail: 'Pat@Example.com', description: 'Shipping to Provo', amount: 450 };

describe('payment rules: small checks', () => {
  it('what it is for, the card statement name and the payment limit', () => {
    expect(paymentPurposeFrom(undefined)).toBe('other');
    expect(paymentPurposeFrom('car_deposit')).toBe('car_deposit');
    expect(paymentPurposeFrom('gift')).toBeNull();
    expect(paymentPurposeFrom({ $ne: 1 })).toBeNull();
    expect(statementSuffixFor('Action Auto Utah')).toBe('ACTION AUT');
    expect(statementSuffixFor("O'Brien & Sons <*>")).toBe('O BRIEN SO');
    expect(statementSuffixFor('123')).toBeUndefined();
    expect(paymentLimitProblem(500, 1000)).toBeNull();
    expect(paymentLimitProblem(1500, 1000)).toMatch(/limit of \$1,000\.00/);
    expect(paymentLimitProblem(0, 1000)).toMatch(/more than \$0/);
  });
});

describe('payment rules: staff payment requests', () => {
  it('a dealership with SuprahPay off can’t send one', async () => {
    dealership({ subscription: { tier: 'suprah_go' } });
    const { error } = await request(valid);
    expect(error?.statusCode).toBe(403);
    expect(error?.message).toMatch(/isn't turned on/);
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('refuses an amount over SuprahPay’s limit, a bad email, another currency or an unknown purpose', async () => {
    dealership({}, { feePercent: 0, maxPaymentAmount: 400 });
    expect((await request(valid)).error?.statusCode).toBe(400);
    dealership();
    for (const bad of [
      { customerEmail: 'not-an-email' },
      { currency: 'eur' },
      { purpose: 'gift' },
      { amount: 10.005 },
      { amount: { $gt: 0 } },
      { customerName: { $ne: '' } },
      { quoteId: 'not-an-id' },
      { dueDate: 'someday' },
    ]) {
      expect((await request({ ...valid, ...bad })).error?.statusCode).toBe(400);
    }
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('saves the purpose, the dealership’s default tax on invoice lines, and Suprah’s fee rate', async () => {
    dealership({ suprahPay: { defaultTaxRate: 10 } }, { feePercent: 2.5, maxPaymentAmount: 999_999.99 });
    const { res, error } = await request({
      ...valid,
      amount: undefined,
      purpose: 'shipping',
      lineItems: [{ label: 'Transport', kind: 'product', quantity: 1, unitPrice: 400 }],
    });
    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(201);
    expect(payments.create).toHaveBeenCalledWith(expect.objectContaining({
      customerEmail: 'pat@example.com',
      currency: 'usd',
      purpose: 'shipping',
      suprahFeePercent: 2.5,
      taxRate: 10,
      subtotal: 400,
      taxAmount: 40,
      amount: 440,
      organizationId: ORG_ID,
    }));
  });

  it('a single amount is what the customer pays (no tax added), and no customer details go in the server log', async () => {
    dealership({ suprahPay: { defaultTaxRate: 10 } });
    const info = jest.spyOn(logger, 'info');
    await request(valid);
    expect(payments.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 450, taxRate: 0, purpose: 'other' }));
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toMatch(/pat@example\.com/i);
    expect(logged).not.toMatch(/Pat Lee/);
    info.mockRestore();
  });

  it('sending a request again needs an unpaid invoice, and says which dealership it is from', async () => {
    payments.findOne.mockResolvedValueOnce({ _id: 'pay-1', status: 'cancelled', amount: 50, customerEmail: 'pat@example.com' });
    let r = await call(paymentController.requestPaymentFromCustomer, { user: STAFF, orgId: ORG_ID, params: { id: 'pay-1' } });
    expect(r.error?.statusCode).toBe(400);

    dealership();
    payments.findOne.mockResolvedValueOnce({ _id: 'pay-1', status: 'pending', amount: 50, description: 'Wash', customerEmail: 'pat@example.com' });
    (User.findOne as jest.Mock).mockResolvedValueOnce({ _id: 'cust-1' });
    r = await call(paymentController.requestPaymentFromCustomer, { user: STAFF, orgId: ORG_ID, params: { id: 'pay-1' } });
    expect(r.error).toBeUndefined();
    // SuprahPay branding with the dealership's name (decision B8, 2026-11-23).
    expect((safeCreateNotification as jest.Mock).mock.calls[0][0]).toMatchObject({
      title: 'SuprahPay invoice from Action Auto Utah',
      message: 'Action Auto Utah sent you an invoice of $50.00 for "Wash". Open SuprahPay to pay it.',
    });
  });
});

describe('payment rules: the Stripe payment page', () => {
  const unpaid = { _id: 'pay-1', amount: 120, status: 'pending', invoiceNumber: 'INV-1', description: 'Carwash', organizationId: ORG_ID, customerEmail: 'pat@example.com', stripeCustomerId: 'cus_1' };
  const pay = () => call(paymentController.createCustomerCheckoutSession, { user: { email: 'pat@example.com' }, body: { paymentId: 'pay-1' } });

  it('cards only, with the dealership’s name on the page, receipt and card statement', async () => {
    dealership();
    payments.findById.mockResolvedValueOnce({ ...unpaid });
    stripe.checkout.sessions.create.mockResolvedValueOnce({ id: 'cs_1', url: 'https://checkout.example/cs_1' });
    const { error } = await pay();
    expect(error).toBeUndefined();
    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.payment_method_types).toEqual(['card']);
    expect(params.line_items[0].price_data.product_data.name).toBe('Action Auto Utah · Invoice INV-1');
    expect(params.payment_intent_data.description).toBe('Action Auto Utah: Carwash');
    expect(params.payment_intent_data.statement_descriptor_suffix).toBe('ACTION AUT');
  });

  it('if Stripe refuses the statement wording, the page still opens without it', async () => {
    dealership();
    payments.findById.mockResolvedValueOnce({ ...unpaid });
    stripe.checkout.sessions.create
      .mockRejectedValueOnce(Object.assign(new Error('Invalid statement_descriptor_suffix'), { param: 'payment_intent_data[statement_descriptor_suffix]' }))
      .mockResolvedValueOnce({ id: 'cs_2', url: 'https://checkout.example/cs_2' });
    const { res, error } = await pay();
    expect(error).toBeUndefined();
    expect(stripe.checkout.sessions.create.mock.calls[1][0].payment_intent_data.statement_descriptor_suffix).toBeUndefined();
    expect(res.body.data.url).toBe('https://checkout.example/cs_2');
  });

  it('an invoice over SuprahPay’s limit can’t be paid online', async () => {
    dealership({}, { feePercent: 0, maxPaymentAmount: 100 });
    payments.findById.mockResolvedValueOnce({ ...unpaid });
    const { error } = await pay();
    expect(error?.statusCode).toBe(400);
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe('payment rules: the customer sees which dealership each invoice is from', () => {
  it('one lookup for all the dealerships, and the dealership id is not sent', async () => {
    payments.find.mockReturnValue(lean([
      { _id: 'p1', amount: 10, status: 'pending', organizationId: ORG_ID },
      { _id: 'p2', amount: 20, status: 'succeeded', organizationId: ORG_ID },
    ]));
    orgs.find.mockReturnValue(lean([{ _id: ORG_ID, name: 'Action Auto Utah' }]));
    const { res } = await call(paymentController.getMyPaymentsAsCustomer, { user: { email: 'pat@example.com' } });
    expect(orgs.find).toHaveBeenCalledTimes(1);
    expect(res.body.data.payments.map((p: any) => p.dealershipName)).toEqual(['Action Auto Utah', 'Action Auto Utah']);
    expect(res.body.data.payments[0]).not.toHaveProperty('organizationId');
  });
});

// ─── Dealership payouts ──────────────────────────────────────────────────────
import DealershipPayout from '../../src/models/DealershipPayout.model';
import { notifyOrgAdmins } from '../../src/utils/safeNotification';
import { owedFor, weekStartUtah } from '../../src/utils/dealershipPayouts';
import { checkSendingPayout, payoutAccountLink, sendDealershipPayout } from '../../src/services/dealershipPayouts.service';
import { connectDealershipPayoutAccount } from '../../src/controllers/dealershipPayouts.controller';

const payouts = DealershipPayout as unknown as Record<string, jest.Mock>;
const READY_ACCOUNT = {
  id: 'acct_dealer', details_submitted: true, payouts_enabled: true, charges_enabled: false,
  capabilities: { transfers: 'active' }, requirements: { currently_due: [], past_due: [] },
};

describe('dealership payouts: the week and what is owed', () => {
  it('a week starts Monday 00:00 Utah time, through daylight saving changes', () => {
    // Wednesday Nov 18 → Monday Nov 16, 00:00 MST (07:00 UTC).
    expect(weekStartUtah(new Date('2026-11-18T12:00:00Z')).toISOString()).toBe('2026-11-16T07:00:00.000Z');
    // Sunday 11:30 pm Utah still belongs to that week; Monday 12:30 am starts the next.
    expect(weekStartUtah(new Date('2026-11-23T06:30:00Z')).toISOString()).toBe('2026-11-16T07:00:00.000Z');
    expect(weekStartUtah(new Date('2026-11-23T07:30:00Z')).toISOString()).toBe('2026-11-23T07:00:00.000Z');
    // Daylight saving began Sunday March 8, 2026: Monday March 9 starts at 00:00 MDT (06:00 UTC).
    expect(weekStartUtah(new Date('2026-03-11T18:00:00Z')).toISOString()).toBe('2026-03-09T06:00:00.000Z');
  });

  it('new payments less Suprah’s fee, a refund after an earlier payout comes off, open disputes are held', () => {
    const owed = owedFor(
      [
        { _id: 'a', status: 'succeeded', amount: 100, suprahFeePercent: 2.5 },
        { _id: 'b', status: 'succeeded', amount: 100, refundedAmount: 40, suprahFeePercent: 2.5 },
        { _id: 'c', status: 'refunded', amount: 100, refundedAmount: 100, suprahFeePercent: 2.5 },
        { _id: 'd', status: 'succeeded', amount: 50, disputeStatus: 'open', disputedAmount: 50 },
        { _id: 'e', status: 'succeeded', amount: 80, suprahFeePercent: 0 },
        { _id: 'f', status: 'succeeded', amount: 30, disputeStatus: 'lost', disputedAmount: 30 },
      ],
      new Map([['c', 97.5], ['e', 80], ['f', 30]]),
      10, // today's rate is only used when an invoice has none recorded
    );
    expect(owed).toEqual({
      amount: 97.5 + 58.5 - 97.5 - 30,
      paymentsTotal: 160,
      suprahFee: 4,
      adjustments: -127.5,
      paymentCount: 4,
      heldCount: 1,
      allocations: [
        { paymentId: 'a', amount: 97.5 },
        { paymentId: 'b', amount: 58.5 },
        { paymentId: 'c', amount: -97.5 },
        { paymentId: 'f', amount: -30 },
      ],
    });
  });
});

describe('dealership payouts: sending (super admins)', () => {
  const START = new Date('2026-11-01T00:00:00Z');
  const paidLastWeek = new Date(weekStartUtah(new Date()).getTime() - 24 * 60 * 60 * 1000);

  function setUp({ amount = 100, claimed = true }: { amount?: number; claimed?: boolean } = {}) {
    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', suprahPay: { stripeAccountId: 'acct_dealer', payoutConfirmedAccountId: 'acct_dealer', payoutsStartAt: START } }));
    orgs.findOneAndUpdate.mockReturnValue(lean(claimed ? { _id: ORG_ID } : null));
    configs.findOne.mockReturnValue(lean(null));
    stripe.accounts.retrieve.mockResolvedValue(READY_ACCOUNT);
    payouts.aggregate.mockResolvedValue([]);
    payments.find.mockReturnValue(lean([{ _id: '64b7f0c2a1b2c3d4e5f60001', organizationId: ORG_ID, status: 'succeeded', amount, suprahFeePercent: 0, paidAt: paidLastWeek }]));
    payouts.create.mockImplementation((doc: any) => Promise.resolve({ _id: 'po-1', createdAt: new Date(), ...doc }));
    payouts.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: 'po-1', status: 'sent' }) }) });
  }

  it('sends the reviewed amount once: recorded first, then Stripe, told never to repeat it', async () => {
    setUp();
    stripe.transfers.create.mockResolvedValueOnce({ id: 'tr_1' });
    await sendDealershipPayout(ORG_ID, 100, 'sa-1');

    expect(payouts.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'sending', amount: 100, approvedBy: 'sa-1' }));
    expect(payouts.create.mock.invocationCallOrder[0]).toBeLessThan(stripe.transfers.create.mock.invocationCallOrder[0]);
    expect(stripe.transfers.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10000, currency: 'usd', destination: 'acct_dealer' }),
      { idempotencyKey: 'dealership-payout-po-1' },
    );
    expect(payouts.updateOne).toHaveBeenCalledWith(
      { _id: 'po-1', status: 'sending' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'sent', stripeTransferId: 'tr_1' }) }),
    );
    expect(notifyOrgAdmins).toHaveBeenCalledWith(ORG_ID, 'admin_broadcast', 'SuprahPay payout sent', expect.stringContaining('$100.00'), expect.any(Object));
    // The one-at-a-time hold is released.
    expect(orgs.updateOne).toHaveBeenCalledWith({ _id: ORG_ID }, { $set: { 'suprahPay.payoutClaimedAt': null } });
  });

  it('refuses if the amount changed since the super admin reviewed it, or another send is under way', async () => {
    setUp({ amount: 120 });
    await expect(sendDealershipPayout(ORG_ID, 100, 'sa-1')).rejects.toMatchObject({ statusCode: 409 });
    expect(payouts.create).not.toHaveBeenCalled();
    expect(orgs.updateOne).toHaveBeenCalled(); // hold released

    jest.clearAllMocks();
    setUp({ claimed: false });
    await expect(sendDealershipPayout(ORG_ID, 100, 'sa-1')).rejects.toMatchObject({ statusCode: 409 });
    expect(payouts.create).not.toHaveBeenCalled();
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it('refuses when the payout account isn’t ready, or the id or amount are wrong', async () => {
    setUp();
    stripe.accounts.retrieve.mockResolvedValueOnce({ ...READY_ACCOUNT, payouts_enabled: false });
    await expect(sendDealershipPayout(ORG_ID, 100, 'sa-1')).rejects.toMatchObject({ statusCode: 409 });
    await expect(sendDealershipPayout('not-an-id', 100, 'sa-1')).rejects.toMatchObject({ statusCode: 400 });
    await expect(sendDealershipPayout(ORG_ID, { $gt: 0 }, 'sa-1')).rejects.toMatchObject({ statusCode: 400 });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it('a definite refusal from Stripe marks it failed; an unclear answer keeps it as sending so it can’t go twice', async () => {
    setUp();
    stripe.transfers.create.mockRejectedValueOnce({ type: 'StripeInvalidRequestError', code: 'balance_insufficient', message: 'Insufficient funds' });
    await expect(sendDealershipPayout(ORG_ID, 100, 'sa-1')).rejects.toMatchObject({ statusCode: 402, message: expect.stringMatching(/balance/) });
    expect(payouts.updateOne).toHaveBeenCalledWith({ _id: 'po-1', status: 'sending' }, { $set: expect.objectContaining({ status: 'failed' }) });

    jest.clearAllMocks();
    setUp();
    stripe.transfers.create.mockRejectedValueOnce({ type: 'StripeConnectionError', message: 'socket hang up' });
    await expect(sendDealershipPayout(ORG_ID, 100, 'sa-1')).rejects.toMatchObject({ statusCode: 402, message: expect.stringMatching(/sending/) });
    const statusChanges = payouts.updateOne.mock.calls.filter(([, update]) => update?.$set?.status);
    expect(statusChanges).toEqual([]);
  });

  it('checking a payout Stripe didn’t confirm asks again with the same key, only within a day', async () => {
    const payout = { _id: 'po-1', organizationId: ORG_ID, amount: 100, paymentCount: 1, status: 'sending', stripeAccountId: 'acct_dealer', createdAt: new Date() };
    payouts.findById
      .mockResolvedValueOnce(payout)
      .mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve({ ...payout, status: 'sent' }) }) });
    stripe.transfers.create.mockResolvedValueOnce({ id: 'tr_1' });
    await checkSendingPayout('64b7f0c2a1b2c3d4e5f60aaa', 'sa-1');
    expect(stripe.transfers.create.mock.calls[0][1]).toEqual({ idempotencyKey: 'dealership-payout-po-1' });

    payouts.findById.mockResolvedValueOnce({ ...payout, createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
    await expect(checkSendingPayout('64b7f0c2a1b2c3d4e5f60aaa', 'sa-1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('dealership payouts: the payout account (dealership admins)', () => {
  it('creates the Stripe account once and keeps the first start date on a reconnect', async () => {
    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', suprahPay: {} }));
    stripe.accounts.create.mockResolvedValueOnce({ id: 'acct_new' });
    orgs.findOneAndUpdate.mockReturnValue(lean({ suprahPay: { stripeAccountId: 'acct_new' } }));
    stripe.accountLinks.create.mockResolvedValueOnce({ url: 'https://connect.stripe.com/setup/x' });

    expect(await payoutAccountLink(ORG_ID, { email: 'owner@example.com', name: 'Olivia Owner' })).toBe('https://connect.stripe.com/setup/x');
    expect(stripe.accounts.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'express', capabilities: { transfers: { requested: true } } }));
    const update = orgs.findOneAndUpdate.mock.calls[0][1];
    expect(update[0].$set['suprahPay.payoutsStartAt']).toEqual({ $ifNull: ['$suprahPay.payoutsStartAt', '$$NOW'] });
    expect(stripe.accountLinks.create).toHaveBeenCalledWith(expect.objectContaining({ account: 'acct_new', type: 'account_onboarding' }));
  });

  it('only a dealership admin can start the setup', async () => {
    const { error } = await call(connectDealershipPayoutAccount, { user: STAFF, orgId: ORG_ID, orgRole: 'member' });
    expect(error?.statusCode).toBe(403);
    expect(stripe.accounts.create).not.toHaveBeenCalled();
  });
});

// ─── Review fixes (2026-11-23) ───────────────────────────────────────────────
import Load from '../../src/models/Load.model';
import { listPayoutsForAdmin } from '../../src/controllers/dealershipPayouts.controller';
import { deleteOrganization } from '../../src/controllers/organization.controller';

describe('review fixes: both card forms check like the payment page', () => {
  const invoice = { _id: 'pay-1', amount: 120, status: 'pending', organizationId: ORG_ID, customerEmail: 'pat@example.com', description: 'Carwash' };

  it('the customer card form refuses a refunded invoice and one over the limit', async () => {
    dealership({}, { feePercent: 0, maxPaymentAmount: 100 });
    const pay = () => call(paymentController.createCustomerPaymentIntent, { user: { email: 'pat@example.com' }, body: { paymentId: 'pay-1' } });
    payments.findById.mockResolvedValueOnce({ ...invoice });
    let r = await pay();
    expect(r.error?.statusCode).toBe(400);
    expect(r.error?.message).toMatch(/SuprahPay's limit for one online payment\. Please contact the dealership/);
    payments.findById.mockResolvedValueOnce({ ...invoice, amount: 50, status: 'refunded' });
    r = await pay();
    expect(r.error?.message).toBe('This invoice has been refunded');
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('the staff card form does too', async () => {
    dealership({}, { feePercent: 0, maxPaymentAmount: 100 });
    const pay = () => call(paymentController.createPaymentIntent, { user: STAFF, orgId: ORG_ID, body: { paymentId: 'pay-1' } });
    payments.findOne.mockResolvedValueOnce({ ...invoice });
    let r = await pay();
    expect(r.error?.statusCode).toBe(400);
    expect(r.error?.message).toMatch(/can't be paid by card here/);
    payments.findOne.mockResolvedValueOnce({ ...invoice, amount: 50, status: 'refunded' });
    r = await pay();
    expect(r.error?.message).toBe('This invoice has been refunded');
    expect(stripe.paymentIntents.create).not.toHaveBeenCalled();
  });
});

describe('review fixes: private SuprahPay details stay on the server', () => {
  it('the payout account, the payout lock and who changed the settings are left out unless named', () => {
    const actual = jest.requireActual('../../src/models/Organization.model').default;
    for (const path of ['suprahPay.stripeAccountId', 'suprahPay.payoutClaimedAt', 'suprahPay.updatedBy']) {
      expect(actual.schema.path(path).options.select).toBe(false);
    }
    for (const path of ['suprahPay.enabled', 'suprahPay.defaultTaxRate']) {
      expect(actual.schema.path(path).options.select).toBeUndefined();
    }
  });
});

describe('review fixes: dealerships Suprah still owes', () => {
  const START = new Date('2026-11-01T00:00:00Z');
  const paidLastWeek = new Date(weekStartUtah(new Date()).getTime() - 24 * 60 * 60 * 1000);
  const ARCHIVED_OWED = '64b7f0c2a1b2c3d4e5f60a01';
  const ARCHIVED_PAID = '64b7f0c2a1b2c3d4e5f60a02';

  it('an archived dealership stays on the payouts list while it is owed money', async () => {
    orgs.find.mockReturnValue(lean([
      { _id: ARCHIVED_OWED, name: 'Archived Owed', status: 'archived', suprahPay: { stripeAccountId: 'acct_a', payoutsStartAt: START } },
      { _id: ARCHIVED_PAID, name: 'Archived Paid', status: 'archived', suprahPay: { stripeAccountId: 'acct_b', payoutsStartAt: START } },
      { _id: ORG_ID, name: 'Action Auto Utah', status: 'active', subscription: { tier: 'suprah_origin' }, suprahPay: {} },
    ]));
    configs.findOne.mockReturnValue(lean(null));
    payouts.aggregate.mockResolvedValue([]);
    payouts.find.mockReturnValue(lean([]));
    payments.find.mockReturnValue(lean([
      { _id: '64b7f0c2a1b2c3d4e5f60b01', organizationId: ARCHIVED_OWED, status: 'succeeded', amount: 50, suprahFeePercent: 0, paidAt: paidLastWeek },
    ]));

    const { res, error } = await call(listPayoutsForAdmin, {});
    expect(error).toBeUndefined();
    expect(orgs.find).toHaveBeenCalledWith({});
    const rows = res.body.data.dealerships;
    expect(rows.map((row: any) => row.name)).toEqual(['Archived Owed', 'Action Auto Utah']);
    expect(rows[0]).toMatchObject({ archived: true, amount: 50 });
    expect(rows[1]).toMatchObject({ archived: false });
  });

  it('deleting a dealership that is owed money warns with the amount; confirming goes ahead', async () => {
    const owner = { _id: { toString: () => 'sa-1' }, role: 'super_admin' };
    const org = { _id: ORG_ID, name: 'Action Auto Utah', ownerId: { toString: () => 'sa-1' }, suprahPay: { payoutsStartAt: START } };
    (Load as unknown as Record<string, jest.Mock>).find.mockReturnValue(lean([]));
    configs.findOne.mockReturnValue(lean(null));
    payouts.aggregate.mockResolvedValue([]);
    payments.find.mockReturnValue(lean([
      { _id: '64b7f0c2a1b2c3d4e5f60b02', organizationId: ORG_ID, status: 'succeeded', amount: 1250, suprahFeePercent: 0, paidAt: paidLastWeek },
    ]));

    orgs.findById.mockResolvedValueOnce(org);
    const refused = await call(deleteOrganization, { user: owner, params: { id: ORG_ID } });
    expect(refused.res.statusCode).toBe(409);
    expect(refused.res.body.message).toMatch(/Suprah still owes Action Auto Utah \$1,250\.00 from SuprahPay card payments/);
    expect(refused.res.body.message).toMatch(/confirmOwed=true/);
    expect(refused.res.body.data).toEqual({ owedAmount: 1250, heldCount: 0 });

    // Confirmed: it goes past the warning (the next step looks up the members).
    const reached = new Error('reached the next step');
    (User as unknown as Record<string, jest.Mock>).find = jest.fn(() => ({ distinct: () => Promise.reject(reached) }));
    orgs.findById.mockResolvedValueOnce(org);
    const confirmed = await call(deleteOrganization, { user: owner, params: { id: ORG_ID }, query: { confirmOwed: 'true' } });
    expect(confirmed.error).toBe(reached);
  });
});

// ─── Stripe's own text never reaches a screen (2026-11-23) ───────────────────
import { mapKnownError } from '../../src/utils/errorMapping';
import { errorHandler } from '../../src/middleware/error.middleware';
import { ApiError } from '../../src/utils/ApiError';
import driverPayoutController from '../../src/controllers/driverPayout.controller';
import { cardFailureReason, driverPayoutFailureReason, refundProblemMessage } from '../../src/utils/stripeErrors';

describe("Stripe's own text never reaches a screen", () => {
  // What Stripe really says when payout accounts aren't switched on.
  const CONNECT_OFF = {
    type: 'StripeInvalidRequestError',
    statusCode: 400,
    requestId: 'req_123',
    message: "You can only create new accounts if you've signed up for Connect, which you can do at https://dashboard.stripe.com/connect.",
  };
  const STRIPE_WORDS = /Connect|dashboard|stripe\.com|MCP|CLI|signed up/i;
  const logged = (spy: jest.SpyInstance) => JSON.stringify(spy.mock.calls);

  it('any Stripe error that reaches the error handler gets a plain message; the log keeps only its type, code and request id', () => {
    expect(mapKnownError(CONNECT_OFF)).toEqual({
      statusCode: 502,
      message: expect.stringMatching(/^This payment action couldn't be completed right now\./),
      errorType: 'PAYMENT_PROVIDER_ERROR',
    });
    expect(mapKnownError({ type: 'StripeConnectionError', message: 'socket hang up' })?.message).toMatch(/couldn't be reached just now/);
    expect(mapKnownError({ type: 'StripeCardError', statusCode: 402, message: 'Your card was declined.' }))
      .toMatchObject({ statusCode: 402, errorType: 'CARD_DECLINED' });
    // Everything else is unchanged.
    expect(mapKnownError(new ApiError(404, 'Not here'))).toBeNull();
    expect(mapKnownError({ name: 'CastError', path: '_id' })?.statusCode).toBe(400);

    const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    const res: any = { status: jest.fn(() => res), send: jest.fn() };
    errorHandler(CONNECT_OFF, { url: '/x', method: 'POST', body: {}, params: {}, query: {} } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(502);
    const sent = res.send.mock.calls[0][0];
    expect(sent.message).toMatch(/contact Suprah AI support/);
    expect(sent.message).not.toMatch(STRIPE_WORDS);
    expect(logged(error)).toContain('req_123');
    expect(logged(error)).not.toMatch(/signed up for Connect/);
    error.mockRestore();
  });

  it('a dealership admin setting up the payout account gets a plain message when Stripe refuses', async () => {
    const warn = jest.spyOn(logger, 'warn');
    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', suprahPay: {} }));
    stripe.accounts.create.mockRejectedValueOnce(CONNECT_OFF);
    const refused = await payoutAccountLink(ORG_ID, { email: 'owner@example.com', name: 'Olivia Owner' }).catch((e) => e);
    expect(refused).toMatchObject({ statusCode: 502, message: expect.stringMatching(/^Payout account setup isn't available right now\./) });
    expect(refused.message).not.toMatch(STRIPE_WORDS);
    expect(logged(warn)).toContain('StripeInvalidRequestError');
    expect(logged(warn)).not.toMatch(/signed up for Connect|owner@example\.com/);

    stripe.accounts.create.mockRejectedValueOnce({ type: 'StripeConnectionError', message: 'socket hang up' });
    await expect(payoutAccountLink(ORG_ID, { email: 'owner@example.com', name: 'Olivia Owner' })).rejects.toMatchObject({ message: expect.stringMatching(/couldn't be reached just now/) });
    warn.mockRestore();
  });

  it('a driver setting up their payout account gets the same plain message', async () => {
    const save = jest.fn();
    (User as unknown as Record<string, jest.Mock>).findById.mockResolvedValueOnce({ _id: 'drv-1', role: 'driver', email: 'd@example.com', save });
    stripe.accounts.create.mockRejectedValueOnce(CONNECT_OFF);
    const { error } = await call(driverPayoutController.initiateDriverOnboarding, { user: { _id: 'drv-1', role: 'driver' } });
    expect(error).toMatchObject({ statusCode: 502, message: expect.stringMatching(/^Payout account setup isn't available right now\./) });
    expect(save).not.toHaveBeenCalled();
  });

  it('card failures, refunds and driver payouts are explained in plain words', () => {
    expect(cardFailureReason({ type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' }))
      .toBe("The card doesn't have enough funds. Use another card.");
    expect(cardFailureReason({ type: 'card_error', code: 'expired_card' })).toBe('The card has expired. Use another card.');
    expect(cardFailureReason({ type: 'card_error', code: 'card_declined', decline_code: 'generic_decline' })).toMatch(/^The card was declined/);
    expect(cardFailureReason({ type: 'invalid_request_error', message: 'No such PaymentMethod: pm_x' })).toMatch(/^The payment didn't go through/);
    expect(cardFailureReason(null)).toMatch(/^The payment didn't go through/);

    expect(refundProblemMessage({ type: 'StripeInvalidRequestError', code: 'charge_already_refunded', message: 'Charge ch_1 has already been refunded.' }))
      .toMatch(/already fully refunded/);
    expect(refundProblemMessage({ type: 'StripeInvalidRequestError', code: 'charge_disputed' })).toMatch(/open dispute/);
    expect(refundProblemMessage(CONNECT_OFF)).not.toMatch(STRIPE_WORDS);

    expect(driverPayoutFailureReason({ type: 'StripeInvalidRequestError', code: 'balance_insufficient' })).toMatch(/enough available money/);
    expect(driverPayoutFailureReason(CONNECT_OFF)).toMatch(/payout account is fully set up/);
  });

  it('a payout Stripe refused gives the super admin a plain reason', async () => {
    const paidLastWeek = new Date(weekStartUtah(new Date()).getTime() - 24 * 60 * 60 * 1000);
    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', suprahPay: { stripeAccountId: 'acct_dealer', payoutConfirmedAccountId: 'acct_dealer', payoutsStartAt: new Date('2026-11-01T00:00:00Z') } }));
    orgs.findOneAndUpdate.mockReturnValue(lean({ _id: ORG_ID }));
    configs.findOne.mockReturnValue(lean(null));
    stripe.accounts.retrieve.mockResolvedValue(READY_ACCOUNT);
    payouts.aggregate.mockResolvedValue([]);
    payments.find.mockReturnValue(lean([{ _id: '64b7f0c2a1b2c3d4e5f60c01', organizationId: ORG_ID, status: 'succeeded', amount: 100, suprahFeePercent: 0, paidAt: paidLastWeek }]));
    payouts.create.mockImplementation((doc: any) => Promise.resolve({ _id: 'po-1', createdAt: new Date(), ...doc }));
    stripe.transfers.create.mockRejectedValueOnce({
      type: 'StripeInvalidRequestError',
      code: 'insufficient_capabilities_for_transfer',
      message: 'Your destination account needs to have at least one of the following capabilities enabled: transfers, crypto_transfers, legacy_payments',
    });

    const refused = await sendDealershipPayout(ORG_ID, 100, 'sa-1').catch((e) => e);
    expect(refused.statusCode).toBe(402);
    expect(refused.message).toMatch(/^The payout wasn't sent, so no money left Suprah's account\./);
    expect(refused.message).not.toMatch(/capabilities|crypto_transfers/);
    expect(payouts.updateOne).toHaveBeenCalledWith({ _id: 'po-1', status: 'sending' }, { $set: { status: 'failed', failureReason: refused.message } });
  });
});

// ─── Batch 6 (2026-11-23): one "awaiting payment" rule, refunds told, safe cancels, saved Stripe ids ──
describe('batch 6: awaiting payment means the same on every screen', () => {
  it('staff Awaiting payment, the staff total and the customer total all count a payment that was started but not finished', async () => {
    payments.find.mockReturnValueOnce(lean([]));
    await call(paymentController.getPendingPayments, { user: STAFF, orgId: ORG_ID });
    expect(payments.find.mock.calls[0][0]).toEqual({ organizationId: ORG_ID, status: { $in: ['pending', 'failed', 'processing'] } });

    payments.aggregate
      .mockResolvedValueOnce([
        { _id: 'pending', count: 1, totalAmount: 10 },
        { _id: 'processing', count: 1, totalAmount: 20.1 },
        { _id: 'failed', count: 1, totalAmount: 5 },
        { _id: 'succeeded', count: 1, totalAmount: 99, keptAmount: 99 },
      ])
      .mockResolvedValueOnce([]);
    const stats = await call(paymentController.getPaymentStats, { user: STAFF, orgId: ORG_ID, query: {} });
    expect(stats.error).toBeUndefined();
    expect(stats.res.body.data.pendingAmount).toBe(35.1);

    payments.find.mockReturnValueOnce(lean([
      { _id: 'a', status: 'pending', amount: 10, organizationId: ORG_ID },
      { _id: 'b', status: 'processing', amount: 20.1, organizationId: ORG_ID },
      { _id: 'c', status: 'succeeded', amount: 5, organizationId: ORG_ID },
    ]));
    orgs.find.mockReturnValueOnce(lean([]));
    const mine = await call(paymentController.getMyPaymentsAsCustomer, { user: { email: 'pat@example.com' } });
    expect(mine.error).toBeUndefined();
    expect(mine.res.body.data.stats).toMatchObject({ totalOwed: 30.1, pendingCount: 2 });
  });
});

describe('batch 6: the customer is told about a refund (decision B5)', () => {
  it('a verified customer gets a refund notice with the dealership and the 5–10 business days note', async () => {
    dealership();
    payments.findOne.mockResolvedValueOnce({
      _id: 'pay-9', status: 'succeeded', amount: 80, refundedAmount: 0, stripePaymentIntentId: 'pi_9',
      customerName: 'Pat', customerEmail: 'Pat@Example.com', description: 'Detailing', invoiceNumber: 'INV-9', organizationId: ORG_ID,
    });
    stripe.refunds.create.mockResolvedValueOnce({ id: 're_1', charge: 'ch_1' });
    stripe.charges.retrieve.mockRejectedValueOnce(new Error('read later'));
    payments.findOneAndUpdate.mockResolvedValueOnce(null);
    (User.findOne as jest.Mock).mockReturnValueOnce(lean({ _id: 'cust-1' }));

    const { error } = await call(paymentController.refundPayment, { user: STAFF, orgId: ORG_ID, params: { id: 'pay-9' }, body: {} });
    expect(error).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    expect(User.findOne).toHaveBeenCalledWith({ email: 'pat@example.com', emailVerified: true });
    const notice = (safeCreateNotification as jest.Mock).mock.calls.map(([n]) => n).find((n) => n.type === 'payment_refunded');
    expect(notice).toMatchObject({
      userId: 'cust-1',
      title: 'Your refund is on its way',
      message: '$80.00 was refunded to you by Action Auto Utah for "Detailing". It can take 5–10 business days to show on your card.',
      metadata: { route: '/customer/payments', invoiceNumber: 'INV-9', amount: 80 },
    });
  });

  it('nobody is told when no verified account has the invoice email', async () => {
    dealership();
    payments.findOne.mockResolvedValueOnce({
      _id: 'pay-9', status: 'succeeded', amount: 80, refundedAmount: 0, stripePaymentIntentId: 'pi_9',
      customerName: 'Pat', customerEmail: 'pat@example.com', description: 'Detailing', organizationId: ORG_ID,
    });
    stripe.refunds.create.mockResolvedValueOnce({ id: 're_2', charge: 'ch_1' });
    stripe.charges.retrieve.mockRejectedValueOnce(new Error('read later'));
    payments.findOneAndUpdate.mockResolvedValueOnce(null);
    (User.findOne as jest.Mock).mockReturnValueOnce(lean(null));

    const { error } = await call(paymentController.refundPayment, { user: STAFF, orgId: ORG_ID, params: { id: 'pay-9' }, body: {} });
    expect(error).toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect((safeCreateNotification as jest.Mock).mock.calls.some(([n]) => n.type === 'payment_refunded')).toBe(false);
  });
});

describe('batch 6: staff Cancel', () => {
  const cancel = () => call(paymentController.cancelPayment, { user: STAFF, orgId: ORG_ID, params: { id: 'pay-5' } });

  it('refuses an invoice that is no longer waiting for payment (refunded or cancelled keep their status)', async () => {
    for (const status of ['refunded', 'cancelled']) {
      payments.findOne.mockResolvedValueOnce({ _id: 'pay-5', status, amount: 10 });
      expect((await cancel()).error).toMatchObject({ statusCode: 400 });
    }
    expect(payments.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("closes the customer's open Stripe page first, then cancels only if it's still waiting", async () => {
    payments.findOne.mockResolvedValueOnce({ _id: 'pay-5', status: 'pending', amount: 10, customerName: 'Pat', stripeCheckoutSessionId: 'cs_open' });
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({ id: 'cs_open', status: 'open', payment_status: 'unpaid' });
    stripe.checkout.sessions.expire.mockResolvedValueOnce({ id: 'cs_open', status: 'expired', payment_status: 'unpaid' });
    payments.findOneAndUpdate.mockResolvedValueOnce({ _id: 'pay-5', status: 'cancelled' });

    const { res, error } = await cancel();
    expect(error).toBeUndefined();
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith('cs_open');
    expect(payments.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'pay-5', organizationId: ORG_ID, status: { $in: ['pending', 'failed', 'processing'] } },
      { $set: { status: 'cancelled' } },
      { new: true },
    );
    expect(res.body.data.status).toBe('cancelled');
  });

  it('an invoice the customer has just paid is marked paid, never cancelled', async () => {
    payments.findOne.mockResolvedValueOnce({ _id: 'pay-5', status: 'processing', amount: 10, stripeCheckoutSessionId: 'cs_paid' });
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({ id: 'cs_paid', status: 'complete', payment_status: 'paid', payment_intent: 'pi_5' });
    payments.findOneAndUpdate.mockResolvedValueOnce(null); // Stripe's paid notice already marked it

    const { error } = await cancel();
    expect(error).toMatchObject({ statusCode: 409, message: expect.stringMatching(/just paid/) });
    expect(payments.findOneAndUpdate.mock.calls[0][1].$set.status).toBe('succeeded');
    expect(payments.findOneAndUpdate.mock.calls.some(([, update]) => update?.$set?.status === 'cancelled')).toBe(false);
  });

  it('a payment confirmed a moment ago is never overwritten', async () => {
    payments.findOne.mockResolvedValueOnce({ _id: 'pay-5', status: 'pending', amount: 10 });
    payments.findOneAndUpdate.mockResolvedValueOnce(null);
    expect((await cancel()).error).toMatchObject({ statusCode: 409 });
  });
});

describe('batch 6: Stripe records Stripe no longer has', () => {
  it('a saved customer and payment page from another Stripe account are replaced, so the invoice can still be paid', async () => {
    dealership();
    payments.findById.mockResolvedValueOnce({
      _id: 'pay-1', amount: 120, status: 'pending', invoiceNumber: 'INV-1', description: 'Carwash', organizationId: ORG_ID,
      customerEmail: 'pat@example.com', customerName: 'Pat', stripeCustomerId: 'cus_old', stripeCheckoutSessionId: 'cs_old',
    });
    const missing = { type: 'StripeInvalidRequestError', code: 'resource_missing' };
    stripe.checkout.sessions.retrieve.mockRejectedValueOnce(missing);
    stripe.customers.retrieve.mockRejectedValueOnce(missing);
    stripe.customers.list.mockResolvedValueOnce({ data: [] });
    stripe.customers.create.mockResolvedValueOnce({ id: 'cus_new' });
    stripe.checkout.sessions.create.mockResolvedValueOnce({ id: 'cs_new', url: 'https://checkout.example/cs_new' });

    const { error } = await call(paymentController.createCustomerCheckoutSession, { user: { email: 'pat@example.com' }, body: { paymentId: 'pay-1' } });
    expect(error).toBeUndefined();
    expect(stripe.checkout.sessions.create.mock.calls[0][0].customer).toBe('cus_new');
  });

  it('a dispute is still recorded when the paid notice never arrived (matched by the invoice id on Stripe’s payment)', async () => {
    const INVOICE = '64b7f0c2a1b2c3d4e5f60d01';
    stripe.webhooks.constructEvent.mockReturnValueOnce({
      type: 'charge.dispute.created',
      data: { object: { id: 'dp_1', payment_intent: 'pi_7', charge: 'ch_7', status: 'needs_response', amount: 5000, reason: 'fraudulent' } },
    });
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_7', metadata: { paymentId: INVOICE } });
    payments.findOneAndUpdate
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: INVOICE, organizationId: ORG_ID, amount: 50, customerName: 'Pat', invoiceNumber: 'INV-7' });

    const { error } = await call(paymentController.handleStripeWebhook, { headers: { 'stripe-signature': 'sig' }, rawBody: Buffer.from('{}') });
    expect(error).toBeUndefined();
    expect(payments.findOneAndUpdate.mock.calls[1][0]).toEqual({ _id: INVOICE });
  });
});

// ─── Batch 7 (2026-11-23): a new or replaced payout account is held until a super admin confirms it ──
import { payoutAccountHold, payoutBankOf } from '../../src/utils/dealershipPayouts';
import { confirmPayoutAccount, payoutAccountFor, payoutAccountForAdmin } from '../../src/services/dealershipPayouts.service';
import { notifyOrgAdmins } from '../../src/utils/safeNotification';

describe('batch 7: payout account safety', () => {
  const BANK = { id: 'ba_1', object: 'bank_account', bank_name: 'STRIPE TEST BANK', last4: '6789', default_for_currency: true };
  const readyWithBank = (bank = BANK) => ({ ...READY_ACCOUNT, business_profile: { name: 'Action Auto Utah LLC' }, external_accounts: { data: [bank] } });
  const superAdmins = () => {
    (User as unknown as Record<string, jest.Mock>).find = jest.fn(() => lean([{ _id: 'sa-1', organizationId: null }]));
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('the hold rule: new, replaced or bank changed, and nothing to hold without an account', () => {
    expect(payoutAccountHold(undefined)).toBeNull();
    expect(payoutAccountHold({})).toBeNull();
    expect(payoutAccountHold({ stripeAccountId: 'acct_1' })).toBe('new');
    expect(payoutAccountHold({ stripeAccountId: 'acct_2', payoutConfirmedAccountId: 'acct_1' })).toBe('replaced');
    expect(payoutAccountHold({ stripeAccountId: 'acct_1', payoutConfirmedAccountId: 'acct_1', payoutBankChangedAt: new Date() })).toBe('bank_changed');
    expect(payoutAccountHold({ stripeAccountId: 'acct_1', payoutConfirmedAccountId: 'acct_1' })).toBeNull();
    expect(payoutBankOf({ external_accounts: { data: [{ id: 'ba_x' }, BANK] } })).toEqual({ id: 'ba_1', bankName: 'STRIPE TEST BANK', last4: '6789' });
    expect(payoutBankOf({})).toBeNull();
  });

  it('setting up a payout account tells the dealership admins (with who did it) and the super admins', async () => {
    superAdmins();
    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', suprahPay: {} }));
    stripe.accounts.create.mockResolvedValueOnce({ id: 'acct_new' });
    orgs.findOneAndUpdate.mockReturnValue(lean({ suprahPay: { stripeAccountId: 'acct_new' } }));
    stripe.accountLinks.create.mockResolvedValueOnce({ url: 'https://connect.stripe.com/setup/x' });

    await payoutAccountLink(ORG_ID, { email: 'owner@example.com', name: 'Olivia Owner' });
    await flush();
    expect(orgs.findOneAndUpdate.mock.calls[0][1][0].$set['suprahPay.payoutAccountSetAt']).toBe('$$NOW');
    const [orgId, , title, message] = (notifyOrgAdmins as jest.Mock).mock.calls[0];
    expect(orgId).toBe(ORG_ID);
    expect(title).toBe('SuprahPay payout account set up');
    expect(message).toMatch(/^Olivia Owner started setting up your dealership's SuprahPay payout account\. Suprah checks it before any payout goes to it\./);
    const superNotice = (safeCreateNotification as jest.Mock).mock.calls.map(([n]) => n).find((n) => n.type === 'admin_system_alert');
    expect(superNotice).toMatchObject({ userId: 'sa-1', title: 'Payout account needs confirming', metadata: { route: '/admin/suprahpay' } });
    expect(superNotice.message).toMatch(/Action Auto Utah is setting up a SuprahPay payout account\. Its payouts are on hold/);
  });

  it('a replaced account says so to the super admins', async () => {
    superAdmins();
    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', suprahPay: { payoutConfirmedAccountId: 'acct_old' } }));
    stripe.accounts.create.mockResolvedValueOnce({ id: 'acct_new' });
    orgs.findOneAndUpdate.mockReturnValue(lean({ suprahPay: { stripeAccountId: 'acct_new' } }));
    stripe.accountLinks.create.mockResolvedValueOnce({ url: 'https://connect.stripe.com/setup/y' });

    await payoutAccountLink(ORG_ID, { email: 'owner@example.com', name: 'Olivia Owner' });
    await flush();
    const superNotice = (safeCreateNotification as jest.Mock).mock.calls.map(([n]) => n).find((n) => n.type === 'admin_system_alert');
    expect(superNotice.message).toMatch(/Action Auto Utah replaced its SuprahPay payout account/);
  });

  it('nothing is sent to an account no super admin has confirmed, or one that was replaced', async () => {
    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', suprahPay: { stripeAccountId: 'acct_dealer' } }));
    stripe.accounts.retrieve.mockResolvedValue(readyWithBank());
    await expect(sendDealershipPayout(ORG_ID, 100, 'sa-1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/hasn't been confirmed yet/) });

    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', suprahPay: { stripeAccountId: 'acct_dealer', payoutConfirmedAccountId: 'acct_other' } }));
    await expect(sendDealershipPayout(ORG_ID, 100, 'sa-1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/set up a different payout account/) });
    expect(payouts.create).not.toHaveBeenCalled();
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it('bank details changed in Stripe since they were confirmed: held, everyone told once, nothing sent', async () => {
    superAdmins();
    orgs.findById.mockReturnValue(lean({
      _id: ORG_ID, name: 'Action Auto Utah',
      suprahPay: { stripeAccountId: 'acct_dealer', payoutConfirmedAccountId: 'acct_dealer', payoutConfirmedBankId: 'ba_old' },
    }));
    stripe.accounts.retrieve.mockResolvedValue(readyWithBank());
    orgs.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });

    await expect(sendDealershipPayout(ORG_ID, 100, 'sa-1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/bank details changed in Stripe/) });
    await flush();
    expect(orgs.updateOne).toHaveBeenCalledWith(
      { _id: ORG_ID, 'suprahPay.payoutConfirmedBankId': 'ba_old', 'suprahPay.payoutBankChangedAt': null },
      { $set: { 'suprahPay.payoutBankChangedAt': expect.any(Date) } },
    );
    expect((notifyOrgAdmins as jest.Mock).mock.calls[0][2]).toBe('SuprahPay payout bank details changed');
    expect((safeCreateNotification as jest.Mock).mock.calls.some(([n]) => n.title === 'Payout bank details changed')).toBe(true);
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it('a super admin sees the bank to check, and confirms only what they saw on a ready account', async () => {
    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, name: 'Action Auto Utah', suprahPay: { stripeAccountId: 'acct_dealer' } }));
    stripe.accounts.retrieve.mockResolvedValue(readyWithBank());
    expect(await payoutAccountForAdmin(ORG_ID)).toMatchObject({
      ready: true, businessName: 'Action Auto Utah LLC', bank: { id: 'ba_1', bankName: 'STRIPE TEST BANK', last4: '6789' }, hold: 'new',
    });

    // A different bank than the one shown: refused, nothing saved.
    await expect(confirmPayoutAccount(ORG_ID, 'ba_other', 'sa-1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/changed since you opened this/) });
    // Not ready yet: refused.
    stripe.accounts.retrieve.mockResolvedValueOnce({ ...readyWithBank(), payouts_enabled: false });
    await expect(confirmPayoutAccount(ORG_ID, 'ba_1', 'sa-1')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/isn't ready yet/) });
    expect(orgs.findOneAndUpdate).not.toHaveBeenCalled();

    orgs.findOneAndUpdate.mockReturnValueOnce(lean({ _id: ORG_ID }));
    expect(await confirmPayoutAccount(ORG_ID, 'ba_1', 'sa-1')).toMatchObject({ confirmed: true, bankLast4: '6789' });
    expect(orgs.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: ORG_ID, 'suprahPay.stripeAccountId': 'acct_dealer' },
      {
        $set: {
          'suprahPay.payoutConfirmedAccountId': 'acct_dealer',
          'suprahPay.payoutConfirmedBankId': 'ba_1',
          'suprahPay.payoutConfirmedAt': expect.any(Date),
          'suprahPay.payoutConfirmedBy': 'sa-1',
        },
        $unset: { 'suprahPay.payoutBankChangedAt': '' },
      },
      { new: true, projection: { _id: 1 } },
    );
    expect((notifyOrgAdmins as jest.Mock).mock.calls[0][3]).toMatch(/Suprah confirmed your dealership's SuprahPay payout account \(bank account ending in 6789\)/);
  });

  it("the dealership sees it's waiting for Suprah, and the super admin list shows why", async () => {
    orgs.findById.mockReturnValue(lean({ _id: ORG_ID, suprahPay: { stripeAccountId: 'acct_dealer' } }));
    stripe.accounts.retrieve.mockResolvedValue(readyWithBank());
    expect(await payoutAccountFor(ORG_ID)).toMatchObject({ ready: true, awaitingConfirmation: true });

    orgs.find.mockReturnValue(lean([
      { _id: ORG_ID, name: 'Action Auto Utah', status: 'active', subscription: { tier: 'suprah_origin' },
        suprahPay: { stripeAccountId: 'acct_dealer', payoutConfirmedAccountId: 'acct_old', payoutAccountSetAt: new Date('2026-11-23T10:00:00Z') } },
    ]));
    configs.findOne.mockReturnValue(lean(null));
    payouts.aggregate.mockResolvedValue([]);
    payouts.find.mockReturnValue(lean([]));
    payments.find.mockReturnValue(lean([]));
    const { res } = await call(listPayoutsForAdmin, {});
    expect(res.body.data.dealerships[0]).toMatchObject({ payoutAccountHold: 'replaced', payoutAccountConnected: true });
  });

  it('who confirmed which account stays on the server', () => {
    const actual = jest.requireActual('../../src/models/Organization.model').default;
    for (const path of ['payoutAccountSetAt', 'payoutConfirmedAccountId', 'payoutConfirmedBankId', 'payoutConfirmedAt', 'payoutConfirmedBy', 'payoutBankChangedAt']) {
      expect(actual.schema.path(`suprahPay.${path}`).options.select).toBe(false);
    }
  });
});
