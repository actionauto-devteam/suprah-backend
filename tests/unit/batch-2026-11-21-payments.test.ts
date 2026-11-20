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
    customers: { list: jest.fn(), create: jest.fn() },
    checkout: { sessions: { retrieve: jest.fn(), create: jest.fn(), expire: jest.fn() } },
  };
  return { __esModule: true, default: jest.fn(() => instance), instance };
});
jest.mock('../../src/models/Payment.model', () => ({
  __esModule: true,
  default: { create: jest.fn(), findOne: jest.fn(), findById: jest.fn(), findByIdAndUpdate: jest.fn(), find: jest.fn() },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: jest.fn(), find: jest.fn() },
}));
jest.mock('../../src/models/SystemConfig.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/services/referral.service', () => ({ __esModule: true, default: { processPaymentReward: jest.fn() } }));
jest.mock('../../src/services/membership.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: jest.fn(() => Promise.resolve()), logFinancialActivity: jest.fn() },
}));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null, emitToUser: jest.fn() }));
jest.mock('../../src/socket/supraspace.socket', () => ({ getIO: () => null }));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: jest.fn(), notifyOrgAdmins: jest.fn() }));

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
    expect((safeCreateNotification as jest.Mock).mock.calls[0][0].message).toMatch(/from Action Auto Utah/);
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
