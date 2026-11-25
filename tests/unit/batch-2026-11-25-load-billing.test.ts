/**
 * Batch 8 (2026-11-25): who pays for a load's shipping, Suprah's automatic
 * SuprahPay invoices, driver payouts and COP/COD cash. Stripe, the database
 * and notifications are stand-ins.
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
  default: { create: jest.fn(), findOne: jest.fn(), findById: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn(), aggregate: jest.fn() },
}));
jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: { findById: jest.fn(), findOne: jest.fn(), find: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() },
}));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: jest.fn(), find: jest.fn() } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findOne: jest.fn(), findById: jest.fn(), find: jest.fn() } }));
jest.mock('../../src/models/SystemConfig.model', () => ({ __esModule: true, default: { findOne: jest.fn(), findOneAndUpdate: jest.fn() } }));
jest.mock('../../src/models/DriverPayout.model', () => ({ __esModule: true, default: { find: jest.fn(), findOne: jest.fn(), create: jest.fn() } }));
jest.mock('../../src/models/DealershipPayout.model', () => ({ __esModule: true, default: { aggregate: jest.fn(), find: jest.fn() } }));
jest.mock('../../src/services/referral.service', () => ({ __esModule: true, default: { processPaymentReward: jest.fn() } }));
jest.mock('../../src/services/membership.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: jest.fn(() => Promise.resolve()), logFinancialActivity: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null, emitToUser: jest.fn(), streamLogToAdmins: jest.fn() }));
jest.mock('../../src/socket/supraspace.socket', () => ({ getIO: () => null }));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: jest.fn(() => Promise.resolve()), notifyOrgAdmins: jest.fn(() => Promise.resolve()) }));
jest.mock('../../src/utils/signedUrlCache', () => ({ getSignedProofUrl: jest.fn(() => Promise.resolve(null)) }));

import Payment from '../../src/models/Payment.model';
import Load from '../../src/models/Load.model';
import Organization from '../../src/models/Organization.model';
import User from '../../src/models/User.model';
import SystemConfig from '../../src/models/SystemConfig.model';
import DriverPayout from '../../src/models/DriverPayout.model';
import { notifyOrgAdmins, safeCreateNotification } from '../../src/utils/safeNotification';
import { clearPlatformSettingsCache } from '../../src/services/suprahPaySettings.service';
import {
  SUPRAH_BILLING_ORG,
  billingFromInput,
  carrierPayCapProblem,
  cashDueNow,
  driverPayGate,
  invoiceTermsFor,
} from '../../src/utils/loadBilling';
import { issueLoadInvoice, pricingEditProblem, setLoadBilling } from '../../src/services/loadBilling.service';
import paymentController from '../../src/controllers/payment.controller';
import driverPayoutController from '../../src/controllers/driverPayout.controller';
import { confirmCashAsCustomer, confirmCashAsDriver } from '../../src/controllers/loadCash.controller';

const stripe = (jest.requireMock('stripe') as { instance: any }).instance;
const payments = Payment as unknown as Record<string, jest.Mock>;
const loads = Load as unknown as Record<string, jest.Mock>;
const orgs = Organization as unknown as Record<string, jest.Mock>;
const users = User as unknown as Record<string, jest.Mock>;
const configs = SystemConfig as unknown as Record<string, jest.Mock>;
const driverPayouts = DriverPayout as unknown as Record<string, jest.Mock>;

const ORG_ID = '64b7f0c2a1b2c3d4e5f60718';
const LOAD_ID = '64b7f0c2a1b2c3d4e5f60a01';

/** A database read that can be chained (.select/.lean/...) and awaited. */
function q(value: unknown) {
  const query: any = { then: (ok: any, fail: any) => Promise.resolve(value).then(ok, fail) };
  for (const step of ['select', 'populate', 'sort', 'limit', 'lean']) query[step] = jest.fn(() => query);
  return query;
}
function call(handler: any, req: Record<string, unknown>): Promise<{ res: any; error: any }> {
  return new Promise((resolve) => {
    const res: any = { statusCode: 200 };
    res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
    res.json = jest.fn((body: unknown) => { res.body = body; resolve({ res, error: undefined }); return res; });
    handler({ headers: {}, params: {}, body: {}, query: {}, ...req }, res, (error: unknown) => resolve({ res, error }));
  });
}
/** SuprahPay on for the dealership, and Suprah's settings. */
function suprahPay(on = true, platform: Record<string, unknown> | null = null) {
  orgs.findById.mockReturnValue(q({ _id: ORG_ID, name: 'Action Auto Utah', subscription: { tier: on ? 'suprah_origin' : 'suprah_go' } }));
  configs.findOne.mockReturnValue(q(platform ? { value: platform } : null));
}

beforeEach(() => {
  jest.resetAllMocks();
  clearPlatformSettingsCache();
  stripe.customers.retrieve.mockImplementation((id: string) => Promise.resolve({ id }));
  (safeCreateNotification as jest.Mock).mockResolvedValue(undefined);
  (notifyOrgAdmins as jest.Mock).mockResolvedValue(undefined);
});

describe('batch 8 rules: who pays for a load', () => {
  const priced = { isPricingEnabled: true, carrierPayAmount: 500 };

  it('pricing skipped means settled outside Suprah, whatever was chosen', () => {
    expect(billingFromInput({ billTo: 'customer', method: 'suprahpay' }, { isPricingEnabled: false })).toEqual({ ok: true, billing: { outside: true } });
  });

  it('a customer or the dealership must be chosen', () => {
    expect(billingFromInput(undefined, priced)).toMatchObject({ ok: false, message: expect.stringMatching(/a customer or your dealership/) });
    expect(billingFromInput({ billTo: 'someone' }, priced).ok).toBe(false);
  });

  it('a dealership load is billed its driver pay through SuprahPay; COP/COD is only for customers', () => {
    expect(billingFromInput({ billTo: 'dealership' }, priced)).toEqual({ ok: true, billing: { billTo: 'dealership', method: 'suprahpay' } });
    expect(billingFromInput({ billTo: 'dealership', method: 'cod' }, priced)).toMatchObject({ ok: false, message: expect.stringMatching(/only for customer loads/) });
    expect(billingFromInput({ billTo: 'dealership' }, { isPricingEnabled: true })).toMatchObject({ ok: false });
  });

  it("a customer load needs the customer's name, email and (for SuprahPay) a shipping price no lower than the driver's pay", () => {
    const customer = { billTo: 'customer', customerName: ' Pat Lee ', customerEmail: 'Pat@Example.com' };
    expect(billingFromInput({ ...customer, customerName: '' }, priced).ok).toBe(false);
    expect(billingFromInput({ ...customer, customerEmail: 'nope' }, priced).ok).toBe(false);
    expect(billingFromInput({ ...customer, shippingPrice: '' }, priced)).toMatchObject({ ok: false, message: expect.stringMatching(/shipping price/) });
    expect(billingFromInput({ ...customer, shippingPrice: 499.99 }, priced)).toMatchObject({ ok: false, message: expect.stringMatching(/can't be more than the customer's shipping price/) });
    expect(billingFromInput({ ...customer, shippingPrice: '650' }, priced)).toEqual({
      ok: true,
      billing: { billTo: 'customer', method: 'suprahpay', customerName: 'Pat Lee', customerEmail: 'pat@example.com', shippingPrice: 650 },
    });
    expect(billingFromInput({ ...customer, method: 'cod' }, priced)).toEqual({
      ok: true,
      billing: { billTo: 'customer', method: 'cod', customerName: 'Pat Lee', customerEmail: 'pat@example.com' },
    });
    expect(billingFromInput({ ...customer, method: 'cheque' }, priced).ok).toBe(false);
    expect(carrierPayCapProblem(500, 500)).toBeNull();
  });

  it('what the automatic invoice is for: the customer pays the shipping price, the dealership the driver pay, cash loads nothing', () => {
    expect(invoiceTermsFor({ billTo: 'customer', method: 'suprahpay', shippingPrice: 650 }, priced)).toEqual({ billedTo: 'customer', amount: 650 });
    expect(invoiceTermsFor({ billTo: 'dealership', method: 'suprahpay' }, priced)).toEqual({ billedTo: 'dealership', amount: 500 });
    expect(invoiceTermsFor({ billTo: 'customer', method: 'cop' }, priced)).toBeNull();
    expect(invoiceTermsFor({ outside: true }, priced)).toBeNull();
  });

  it('the driver is paid the carrier pay only once the shipping is paid', () => {
    const customerLoad = { billing: { billTo: 'customer' as const, method: 'suprahpay' as const }, pricing: priced };
    expect(driverPayGate({ pricing: { isPricingEnabled: false } }, null)).toMatchObject({ ok: false, code: 'outside' });
    expect(driverPayGate({ pricing: priced }, null)).toMatchObject({ ok: false, code: 'needs_billing' });
    expect(driverPayGate({ billing: { billTo: 'customer', method: 'cod' }, pricing: priced }, null)).toMatchObject({ ok: false, code: 'cash' });
    expect(driverPayGate({ ...customerLoad, pricing: { isPricingEnabled: true } }, 'succeeded')).toMatchObject({ ok: false, code: 'no_amount' });
    expect(driverPayGate(customerLoad, 'pending')).toMatchObject({ ok: false, code: 'awaiting_payment', message: expect.stringMatching(/customer hasn't paid/) });
    expect(driverPayGate({ ...customerLoad, billing: { billTo: 'dealership', method: 'suprahpay' } }, 'processing'))
      .toMatchObject({ ok: false, message: expect.stringMatching(/Bills from Suprah/) });
    expect(driverPayGate(customerLoad, 'refunded')).toMatchObject({ ok: false, code: 'refunded' });
    expect(driverPayGate(customerLoad, 'succeeded')).toEqual({ ok: true, amount: 500 });
  });

  it('COP is due from pickup, COD at delivery', () => {
    expect(cashDueNow('cop', 'Picked Up')).toBe(true);
    expect(cashDueNow('cop', 'Assigned')).toBe(false);
    expect(cashDueNow('cod', 'In-Transit')).toBe(false);
    expect(cashDueNow('cod', 'Delivered')).toBe(true);
    expect(cashDueNow('suprahpay', 'Delivered')).toBe(false);
  });
});

describe('batch 8: the automatic SuprahPay shipping invoice', () => {
  const load = (billing: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    _id: LOAD_ID, organizationId: ORG_ID, loadNumber: 'L-100', status: 'Posted', createdBy: 'staff-1',
    pricing: { isPricingEnabled: true, carrierPayAmount: 500 }, billing, ...extra,
  });

  it("a customer's invoice is Suprah's money: no tax, no fee, linked to the load and the dealership", async () => {
    suprahPay();
    loads.findById.mockReturnValueOnce(q(load({ billTo: 'customer', method: 'suprahpay', customerName: 'Pat Lee', customerEmail: 'pat@example.com', shippingPrice: 650 })));
    users.findById.mockReturnValue(q({ email: 'staff@dealer.com' }));
    payments.create.mockImplementation((doc: any) => Promise.resolve({ _id: 'inv-1', ...doc }));
    loads.findOneAndUpdate.mockReturnValueOnce(q({ _id: LOAD_ID }));
    users.findOne.mockReturnValueOnce(q({ _id: 'cust-1' }));

    const invoice: any = await issueLoadInvoice(LOAD_ID);
    expect(payments.create).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: SUPRAH_BILLING_ORG, forOrganizationId: ORG_ID, billedTo: 'customer', loadId: LOAD_ID,
      customerEmail: 'pat@example.com', amount: 650, taxRate: 0, suprahFeePercent: 0, purpose: 'shipping', status: 'pending',
    }));
    expect(loads.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: LOAD_ID, 'billing.invoiceId': null });
    expect(invoice._id).toBe('inv-1');
    expect(safeCreateNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'cust-1', type: 'payment_request', title: 'SuprahPay invoice for your shipment',
      message: expect.stringContaining('Suprah AI sent you an invoice of $650.00 for shipping your vehicle with Action Auto Utah (load L-100)'),
    }));
  });

  it("the dealership is billed its driver's pay and its admins are told where to pay it", async () => {
    suprahPay();
    loads.findById.mockReturnValueOnce(q(load({ billTo: 'dealership', method: 'suprahpay' })));
    users.findById.mockReturnValue(q({ email: 'staff@dealer.com' }));
    payments.create.mockImplementation((doc: any) => Promise.resolve({ _id: 'inv-2', ...doc }));
    loads.findOneAndUpdate.mockReturnValueOnce(q({ _id: LOAD_ID }));

    await issueLoadInvoice(LOAD_ID);
    expect(payments.create).toHaveBeenCalledWith(expect.objectContaining({ billedTo: 'dealership', amount: 500, customerName: 'Action Auto Utah', customerEmail: 'staff@dealer.com' }));
    expect(notifyOrgAdmins).toHaveBeenCalledWith(ORG_ID, 'payment_pending', 'Shipping bill from Suprah', expect.stringContaining('$500.00'), expect.objectContaining({ route: '/billing' }));
  });

  it('nothing is sent over SuprahPay’s payment limit', async () => {
    suprahPay(true, { feePercent: 0, maxPaymentAmount: 400 });
    loads.findById.mockReturnValueOnce(q(load({ billTo: 'dealership', method: 'suprahpay' })));
    await expect(issueLoadInvoice(LOAD_ID)).rejects.toMatchObject({ statusCode: 400 });
    expect(payments.create).not.toHaveBeenCalled();
  });

  it('a paid invoice is never billed again, and cash loads get no invoice', async () => {
    loads.findById.mockReturnValueOnce(q(load({ billTo: 'customer', method: 'suprahpay', shippingPrice: 650, invoiceId: 'inv-1' })));
    payments.findById.mockReturnValueOnce(q({ _id: 'inv-1', status: 'succeeded', amount: 600, billedTo: 'customer' }));
    expect(await issueLoadInvoice(LOAD_ID)).toMatchObject({ _id: 'inv-1' });
    loads.findById.mockReturnValueOnce(q(load({ billTo: 'customer', method: 'cod' })));
    expect(await issueLoadInvoice(LOAD_ID)).toBeNull();
    expect(payments.create).not.toHaveBeenCalled();
  });

  it("billing can't change once the shipping is paid, or on a load settled outside Suprah", async () => {
    suprahPay();
    loads.findById.mockReturnValueOnce(q(load({ billTo: 'customer', method: 'suprahpay', shippingPrice: 650, invoiceId: 'inv-1' })));
    payments.findById.mockReturnValueOnce(q({ _id: 'inv-1', status: 'succeeded' }));
    await expect(setLoadBilling(LOAD_ID, ORG_ID, { billTo: 'customer', method: 'cod' }, 'staff-1')).rejects.toMatchObject({ statusCode: 409 });
    loads.findById.mockReturnValueOnce(q(load({ outside: true }, { pricing: { isPricingEnabled: false } })));
    await expect(setLoadBilling(LOAD_ID, ORG_ID, { billTo: 'dealership' }, 'staff-1')).rejects.toMatchObject({ statusCode: 400 });
  });

  it("Edit Load: the driver's pay can't pass the customer's price, and can't change after the dealership paid", async () => {
    loads.findById.mockReturnValueOnce(q(load({ billTo: 'customer', method: 'suprahpay', shippingPrice: 650 })));
    expect(await pricingEditProblem(LOAD_ID, { carrierPayAmount: 700 })).toMatch(/can't be more than/);
    loads.findById.mockReturnValueOnce(q(load({ billTo: 'dealership', method: 'suprahpay', invoiceId: 'inv-2' })));
    payments.findById.mockReturnValueOnce(q({ _id: 'inv-2', status: 'succeeded', amount: 500 }));
    expect(await pricingEditProblem(LOAD_ID, { carrierPayAmount: 450 })).toMatch(/already paid this load's bill of \$500\.00/);
  });
});

describe("batch 8: converting a quote", () => {
  it("never cancels a hand-sent Shipping invoice it can't match to the quote: the admins are told instead", async () => {
    suprahPay();
    payments.find
      .mockReturnValueOnce(q([])) // nothing linked to this quote
      .mockReturnValueOnce(q([{ invoiceNumber: "INV-7", amount: 640, status: "pending" }]));
    loads.findById
      .mockReturnValueOnce(q({ _id: LOAD_ID, organizationId: ORG_ID, loadNumber: "L-200", status: "Draft", quoteId: "quote-1", createdBy: "staff-1", pricing: { isPricingEnabled: true, carrierPayAmount: 600 }, billing: {} }))
      .mockReturnValueOnce(q({ _id: LOAD_ID, organizationId: ORG_ID, loadNumber: "L-200", status: "Draft", quoteId: "quote-1", createdBy: "staff-1", pricing: { isPricingEnabled: true, carrierPayAmount: 600 }, billing: { billTo: "customer", method: "suprahpay", customerName: "Pat Lee", customerEmail: "pat@example.com", shippingPrice: 640 } }))
      .mockReturnValueOnce(q({ billing: { billTo: "customer" } }))
      .mockReturnValueOnce(q({ loadNumber: "L-200" }));
    loads.updateOne.mockResolvedValue({});
    users.findById.mockReturnValue(q({ email: "staff@dealer.com" }));
    payments.create.mockImplementation((doc: any) => Promise.resolve({ _id: "inv-9", ...doc }));
    loads.findOneAndUpdate.mockReturnValueOnce(q({ _id: LOAD_ID }));
    users.findOne.mockReturnValueOnce(q(null));
    const { billConvertedQuoteLoad } = await import("../../src/services/loadBilling.service");
    await billConvertedQuoteLoad(LOAD_ID, { _id: "quote-1", firstName: "Pat", lastName: "Lee", email: "Pat@Example.com", rate: 640 }, ORG_ID, "staff-1");
    expect(payments.find.mock.calls[1][0]).toMatchObject({ organizationId: ORG_ID, purpose: "shipping", customerEmail: "pat@example.com", quoteId: { $exists: false }, loadId: { $exists: false } });
    expect(payments.updateOne).not.toHaveBeenCalled();
    expect(notifyOrgAdmins).toHaveBeenCalledWith(ORG_ID, "general", "Check for a second shipping invoice", expect.stringContaining("INV-7 for $640.00"), expect.anything());
  });
});

describe("batch 8: paying a load's driver", () => {
  const delivered = (billing: Record<string, unknown> | undefined) => ({
    _id: LOAD_ID, organizationId: ORG_ID, loadNumber: 'L-100', status: 'Delivered', assignedDriverId: 'driver-1',
    proofOfDelivery: { confirmedAt: new Date() }, pricing: { isPricingEnabled: true, carrierPayAmount: 500 }, billing,
  });
  const pay = (body: Record<string, unknown>) =>
    call(driverPayoutController.createPayout, { user: { _id: 'staff-1', role: 'admin' }, orgId: ORG_ID, body: { loadId: LOAD_ID, driverId: 'driver-1', ...body } });

  it("SuprahPay off for the dealership: drivers aren't paid through it", async () => {
    suprahPay(false);
    expect((await pay({})).error).toMatchObject({ statusCode: 403 });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it("waits for the customer's payment, and never for a cash load", async () => {
    suprahPay();
    loads.findOne.mockResolvedValueOnce(delivered({ billTo: 'customer', method: 'suprahpay', invoiceId: 'inv-1' }));
    payments.findById.mockReturnValueOnce(q({ status: 'pending' }));
    expect((await pay({})).error).toMatchObject({ statusCode: 409, message: expect.stringMatching(/hasn't paid/) });
    loads.findOne.mockResolvedValueOnce(delivered({ billTo: 'customer', method: 'cop' }));
    expect((await pay({})).error).toMatchObject({ statusCode: 409, message: expect.stringMatching(/in cash/) });
    loads.findOne.mockResolvedValueOnce(delivered(undefined));
    expect((await pay({})).error).toMatchObject({ statusCode: 409, message: expect.stringMatching(/Choose who pays/) });
    expect(stripe.transfers.create).not.toHaveBeenCalled();
  });

  it('pays exactly the carrier pay once the shipping is paid, and refuses a different typed amount', async () => {
    suprahPay();
    loads.findOne.mockResolvedValueOnce(delivered({ billTo: 'dealership', method: 'suprahpay', invoiceId: 'inv-2' }));
    payments.findById.mockReturnValueOnce(q({ status: 'succeeded' }));
    expect((await pay({ amount: 450 })).error).toMatchObject({ statusCode: 409, message: expect.stringMatching(/is \$500\.00 now/) });

    loads.findOne.mockResolvedValueOnce(delivered({ billTo: 'dealership', method: 'suprahpay', invoiceId: 'inv-2' }));
    payments.findById.mockReturnValueOnce(q({ status: 'succeeded' }));
    users.findOne.mockResolvedValueOnce({ _id: 'driver-1', name: 'Dee', email: 'dee@example.com', stripeConnectAccountId: 'acct_driver' });
    loads.findOneAndUpdate.mockResolvedValueOnce({ _id: LOAD_ID });
    loads.updateOne.mockReturnValue(Promise.resolve());
    driverPayouts.findOne.mockResolvedValueOnce(null);
    const payout: any = { _id: 'po-1', description: 'Payout for load L-100', save: jest.fn() };
    driverPayouts.create.mockResolvedValueOnce(payout);
    stripe.transfers.create.mockResolvedValueOnce({ id: 'tr_1' });
    const { error } = await pay({});
    expect(error).toBeUndefined();
    expect(driverPayouts.create).toHaveBeenCalledWith(expect.objectContaining({ amount: 500 }));
    expect(stripe.transfers.create.mock.calls[0][0]).toMatchObject({ amount: 50000, destination: 'acct_driver' });
  });
});

describe('batch 8: COP/COD cash', () => {
  const cashLoad = (fields: Record<string, unknown> = {}) => ({
    _id: LOAD_ID, organizationId: ORG_ID, loadNumber: 'L-100', status: 'Delivered', assignedDriverId: 'driver-1', dispatchOwnerId: 'disp-1',
    pricing: { isPricingEnabled: true, carrierPayAmount: 500 }, billing: { billTo: 'customer', method: 'cod' }, ...fields,
  });
  const driverSays = (received: unknown) =>
    call(confirmCashAsDriver, { user: { _id: 'driver-1', name: 'Dee' }, params: { id: LOAD_ID }, body: { received } });

  it('the driver confirms the cash, which settles it', async () => {
    loads.findOne.mockReturnValueOnce(q(cashLoad()));
    loads.findOneAndUpdate.mockReturnValueOnce(q(cashLoad({ billing: { billTo: 'customer', method: 'cod', cashConfirmedAt: new Date() } })));
    const { res, error } = await driverSays(true);
    expect(error).toBeUndefined();
    expect(loads.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: LOAD_ID, assignedDriverId: 'driver-1', 'billing.cashConfirmedAt': null });
    expect(res.body.data.driverConfirmedAt).toBeTruthy();
    expect(notifyOrgAdmins).not.toHaveBeenCalled();
  });

  it("'not paid' tells the dispatcher and the dealership's admins", async () => {
    loads.findOne.mockReturnValueOnce(q(cashLoad()));
    loads.findOneAndUpdate.mockReturnValueOnce(q(cashLoad({ billing: { billTo: 'customer', method: 'cod', cashNotReceivedAt: new Date() } })));
    await driverSays(false);
    const message = "Dee says they weren't paid the cash on delivery (COD) of $500.00 for load L-100. Contact the customer to sort it out.";
    expect(notifyOrgAdmins).toHaveBeenCalledWith(ORG_ID, 'general', 'Driver not paid in cash', message, expect.anything());
    expect(safeCreateNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: 'disp-1', message }));
  });

  it('COD waits for delivery, and a SuprahPay load has no cash to confirm', async () => {
    loads.findOne.mockReturnValueOnce(q(cashLoad({ status: 'In-Transit' })));
    expect((await driverSays(true)).error).toMatchObject({ statusCode: 400, message: expect.stringMatching(/once the car is delivered/) });
    loads.findOne.mockReturnValueOnce(q(cashLoad({ billing: { billTo: 'customer', method: 'suprahpay' } })));
    expect((await driverSays(true)).error).toMatchObject({ statusCode: 400 });
    expect((await driverSays('yes')).error).toMatchObject({ statusCode: 400 });
  });

  it('the customer confirms paying from My Shipments, only with a verified email that matches the load', async () => {
    users.findById.mockReturnValueOnce(q({ email: 'Pat@Example.com', emailVerified: true }));
    loads.findOne.mockReturnValueOnce(q(cashLoad()));
    loads.findOneAndUpdate.mockReturnValueOnce(q(cashLoad({ billing: { billTo: 'customer', method: 'cod', cashCustomerConfirmedAt: new Date() } })));
    const { res } = await call(confirmCashAsCustomer, { user: { _id: 'cust-1' }, params: { loadId: LOAD_ID } });
    expect(loads.findOne.mock.calls[0][0]).toMatchObject({ 'billing.customerEmail': 'pat@example.com' });
    expect(res.body.data).toMatchObject({ amount: 500, customerConfirmedAt: expect.anything() });

    users.findById.mockReturnValueOnce(q({ email: 'pat@example.com', emailVerified: false }));
    expect((await call(confirmCashAsCustomer, { user: { _id: 'cust-1' }, params: { loadId: LOAD_ID } })).error).toMatchObject({ statusCode: 403 });
  });
});

describe("batch 8: customers and Suprah's invoices", () => {
  it("a dealership's bill is never a person's invoice, and Suprah's shipping invoices are signed Suprah AI", async () => {
    payments.find.mockReturnValueOnce(q([
      { _id: 'inv-1', organizationId: SUPRAH_BILLING_ORG, status: 'pending', amount: 650, billedTo: 'customer' },
      { _id: 'pay-2', organizationId: ORG_ID, status: 'succeeded', amount: 50 },
    ]));
    orgs.find.mockReturnValueOnce(q([{ _id: ORG_ID, name: 'Action Auto Utah' }]));
    const { res } = await call(paymentController.getMyPaymentsAsCustomer, { user: { email: 'Pat@Example.com' } });
    expect(payments.find.mock.calls[0][0]).toEqual({ customerEmail: 'pat@example.com', billedTo: { $ne: 'dealership' } });
    const names = res.body.data.payments.map((p: any) => p.dealershipName);
    expect(names).toEqual(['Suprah AI', 'Action Auto Utah']);
  });

  it("a dealership's bill can't be paid from a personal account, and a booked shipment's invoice can't be cancelled by the customer", async () => {
    payments.findById.mockResolvedValueOnce({ _id: 'inv-2', customerEmail: 'staff@dealer.com', status: 'pending', billedTo: 'dealership', amount: 500 });
    expect((await call(paymentController.createCustomerCheckoutSession, { user: { email: 'staff@dealer.com' }, body: { paymentId: 'inv-2' } })).error)
      .toMatchObject({ statusCode: 403, message: expect.stringMatching(/dealership's SuprahPay page/) });
    payments.findById.mockResolvedValueOnce({ _id: 'inv-1', customerEmail: 'pat@example.com', status: 'pending', billedTo: 'customer', amount: 650 });
    expect((await call(paymentController.cancelMyPayment, { user: { email: 'pat@example.com' }, params: { id: 'inv-1' } })).error)
      .toMatchObject({ statusCode: 400, message: expect.stringMatching(/booked shipment/) });
  });

  it("the dealership lists and pays only its own bills from Suprah", async () => {
    payments.find.mockReturnValueOnce(q([]));
    await call(paymentController.getSuprahBills, { user: { _id: 'staff-1' }, orgId: ORG_ID });
    expect(payments.find.mock.calls[0][0]).toEqual({ organizationId: SUPRAH_BILLING_ORG, forOrganizationId: ORG_ID, billedTo: 'dealership' });

    payments.findOne.mockResolvedValueOnce(null);
    const { error } = await call(paymentController.paySuprahBill, { user: { _id: 'staff-1' }, orgId: ORG_ID, params: { id: '64b7f0c2a1b2c3d4e5f60b02' } });
    expect(error).toMatchObject({ statusCode: 404 });
    expect(payments.findOne.mock.calls[0][0]).toEqual({ _id: '64b7f0c2a1b2c3d4e5f60b02', organizationId: SUPRAH_BILLING_ORG, forOrganizationId: ORG_ID, billedTo: 'dealership' });
  });
});

describe("Stripe's payment page: cards only, and closing it leaves the invoice due", () => {
  it('opens with cards only (no Link, bank or Klarna), in US dollars, without changing the invoice', async () => {
    suprahPay();
    payments.findById.mockResolvedValueOnce({ _id: 'pay-1', amount: 10, status: 'pending', organizationId: ORG_ID, customerEmail: 'pat@example.com', customerName: 'Pat', stripeCustomerId: 'cus_1' });
    stripe.checkout.sessions.create.mockResolvedValueOnce({ id: 'cs_1', url: 'https://checkout.example/cs_1' });
    payments.findOneAndUpdate.mockResolvedValueOnce({ _id: 'pay-1', status: 'pending' });
    const { error } = await call(paymentController.createCustomerCheckoutSession, { user: { email: 'pat@example.com' }, body: { paymentId: 'pay-1' } });
    expect(error).toBeUndefined();
    const params = stripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.payment_method_types).toEqual(['card']);
    expect(params.wallet_options).toEqual({ link: { display: 'never' } });
    expect(params.adaptive_pricing).toEqual({ enabled: false });
    expect(payments.findOneAndUpdate.mock.calls[0][1]).toEqual({ $set: { stripeCheckoutSessionId: 'cs_1', stripeCustomerId: 'cus_1' } });
  });

  it('a "Payment started" invoice whose Stripe page was closed goes back to due; a paid one shows paid; a bank still processing stays', async () => {
    payments.find.mockReturnValueOnce(q([
      { _id: 'p-closed', status: 'processing', stripeCheckoutSessionId: 'cs_closed', organizationId: ORG_ID, amount: 10 },
      { _id: 'p-paid', status: 'processing', stripeCheckoutSessionId: 'cs_paid', organizationId: ORG_ID, amount: 20 },
      { _id: 'p-bank', status: 'processing', stripeCheckoutSessionId: 'cs_old', stripePaymentIntentId: 'pi_bank', organizationId: ORG_ID, amount: 30 },
    ]));
    orgs.find.mockReturnValueOnce(q([{ _id: ORG_ID, name: 'Action Auto Utah' }]));
    stripe.checkout.sessions.retrieve.mockImplementation((id: string) => Promise.resolve(
      id === 'cs_paid' ? { id, payment_status: 'paid', payment_intent: 'pi_paid' } : { id, status: 'open', payment_status: 'unpaid' },
    ));
    stripe.paymentIntents.retrieve.mockResolvedValueOnce({ id: 'pi_bank', status: 'processing' });
    payments.updateOne.mockResolvedValue({ modifiedCount: 1 });
    payments.findOneAndUpdate.mockResolvedValueOnce({ _id: 'p-paid', status: 'succeeded', organizationId: ORG_ID, amount: 20, customerName: 'Pat' });

    const { res } = await call(paymentController.getMyPaymentsAsCustomer, { user: { email: 'pat@example.com' } });
    const status = Object.fromEntries(res.body.data.payments.map((p: any) => [p._id, p.status]));
    expect(status).toEqual({ 'p-closed': 'pending', 'p-paid': 'succeeded', 'p-bank': 'processing' });
    expect(payments.updateOne).toHaveBeenCalledTimes(1);
    expect(payments.updateOne).toHaveBeenCalledWith({ _id: 'p-closed', status: 'processing' }, { $set: { status: 'pending' } });
    // Stripe's ids are only used here, never sent to the customer.
    expect(JSON.stringify(res.body.data)).not.toMatch(/cs_closed|pi_bank/);
  });
});
