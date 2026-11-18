/**
 * Suprah Pay fixes (2026-11-19), one section per fix. No database or Stripe
 * account is used: sign-in, controllers and models are replaced with
 * stand-ins where a section needs them.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth.middleware', () => ({
  __esModule: true,
  default: () => (req: any, _res: any, next: any) => {
    req.user = { _id: 'user-1', role: req.headers['x-test-role'] };
    req.orgId = 'org-1';
    next();
  },
}));
jest.mock('../../src/controllers/payment.controller', () => {
  const ok = (_req: any, res: any) => res.status(200).json({ ok: true });
  return {
    __esModule: true,
    default: new Proxy({}, { get: () => ok }),
  };
});

jest.mock('../../src/models/transaction.model', () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn(), findById: jest.fn(), updateOne: jest.fn() },
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findOneAndUpdate: jest.fn(), exists: jest.fn(), findById: jest.fn() },
}));
jest.mock('../../src/models/AuditLog.model', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../src/models/referral.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Load.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Payment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/safeNotification', () => ({
  safeCreateNotification: jest.fn(),
  notifyOrgAdmins: jest.fn(),
}));

import paymentRoutes from '../../src/routes/payment.routes';
import {
  refundRequestFor,
  refundStateFromCharge,
  refundUpdate,
  remainingRefundable,
} from '../../src/utils/paymentRefund';
import { payoutAccountStatus, payoutFailedNotice } from '../../src/utils/driverPayoutAccount';
import { withdrawalRequestFrom } from '../../src/utils/walletWithdrawal';
import adminReferral from '../../src/controllers/admin.referral.controller';
import Transaction from '../../src/models/transaction.model';
import User from '../../src/models/User.model';
import AuditLog from '../../src/models/AuditLog.model';

describe('payments are staff-only', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentRoutes);
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err.statusCode || 500).json({ message: err.message }),
  );

  const staffRoutes: Array<[string, string]> = [
    ['get', '/api/payments'],
    ['post', '/api/payments'],
    ['get', '/api/payments/stats'],
    ['get', '/api/payments/balance'],
    ['get', '/api/payments/pending'],
    ['post', '/api/payments/create-intent'],
    ['post', '/api/payments/confirm'],
    ['get', '/api/payments/p1'],
    ['patch', '/api/payments/p1'],
    ['post', '/api/payments/p1/cancel'],
    ['post', '/api/payments/p1/refund'],
    ['post', '/api/payments/p1/request'],
  ];
  const customerRoutes: Array<[string, string]> = [
    ['get', '/api/payments/my-payments'],
    ['post', '/api/payments/create-customer-intent'],
    ['post', '/api/payments/confirm-customer'],
    ['post', '/api/payments/create-customer-checkout'],
    ['get', '/api/payments/checkout-session/cs_1'],
    ['post', '/api/payments/p1/cancel-mine'],
  ];
  const as = (method: string, path: string, role: string) =>
    (request(app) as any)[method](path).set('x-test-role', role);

  it.each(['customer', 'driver'])('refuses a %s account on every staff action', async (role) => {
    for (const [method, path] of staffRoutes) {
      const res = await as(method, path, role);
      expect([method, path, res.status]).toEqual([method, path, 403]);
      expect(res.body.message).toBe("Only your dealership's staff can view or manage payments.");
    }
  });

  it.each(['employee', 'admin', 'super_admin'])('lets %s staff use the staff actions', async (role) => {
    for (const [method, path] of staffRoutes) {
      const res = await as(method, path, role);
      expect([method, path, res.status]).toEqual([method, path, 200]);
    }
  });

  it('keeps the customer actions open to customers (they only reach their own invoices)', async () => {
    for (const [method, path] of customerRoutes) {
      const res = await as(method, path, 'customer');
      expect([method, path, res.status]).toEqual([method, path, 200]);
    }
  });
});

describe('refunds', () => {
  const paid = { amount: 100 };

  it('refunds everything left when no amount is given', () => {
    expect(refundRequestFor(paid, undefined)).toEqual({ ok: true, amount: 100, explicit: false });
    expect(refundRequestFor({ amount: 100, refundedAmount: 40 }, '')).toEqual({ ok: true, amount: 60, explicit: false });
  });

  it('accepts a partial amount in dollars and cents, as a number or text', () => {
    expect(refundRequestFor(paid, 25.5)).toEqual({ ok: true, amount: 25.5, explicit: true });
    expect(refundRequestFor(paid, ' 10.10 ')).toEqual({ ok: true, amount: 10.1, explicit: true });
    expect(refundRequestFor({ amount: 100, refundedAmount: 40 }, 60)).toEqual({ ok: true, amount: 60, explicit: true });
  });

  it.each([
    [0, 'Enter a refund amount greater than $0.'],
    [-5, 'Enter a refund amount greater than $0.'],
    ['abc', 'Enter a refund amount greater than $0.'],
    [Number.NaN, 'Enter a refund amount greater than $0.'],
    [{}, 'Enter a refund amount greater than $0.'],
    [10.005, 'Enter the refund amount in dollars and cents, for example 25.50.'],
    [100.01, 'You can refund up to $100.00 on this payment.'],
  ])('refuses %p', (requested, message) => {
    expect(refundRequestFor(paid, requested)).toEqual({ ok: false, message });
  });

  it('never refunds more than what is left', () => {
    expect(refundRequestFor({ amount: 100, refundedAmount: 70 }, 30.01)).toEqual({
      ok: false,
      message: 'You can refund up to $30.00 on this payment.',
    });
    expect(refundRequestFor({ amount: 100, refundedAmount: 100 }, undefined)).toEqual({
      ok: false,
      message: 'This payment has already been fully refunded.',
    });
    expect(remainingRefundable({ amount: 19.99, refundedAmount: 5.33 })).toBe(14.66);
    expect(remainingRefundable({ amount: 10, refundedAmount: 12 })).toBe(0);
  });

  it("reads Stripe's totals: a partial refund is not a full one", () => {
    expect(refundStateFromCharge({ amount_refunded: 2550, refunded: false })).toEqual({ refundedAmount: 25.5, fullyRefunded: false });
    expect(refundStateFromCharge({ amount_refunded: 10000, refunded: true })).toEqual({ refundedAmount: 100, fullyRefunded: true });
    expect(refundStateFromCharge({})).toEqual({ refundedAmount: 0, fullyRefunded: false });
  });

  it('only marks the payment refunded when all of it went back, and never lowers the total', () => {
    const at = new Date('2026-11-19T00:00:00Z');
    expect(refundUpdate({ refundedAmount: 25.5, fullyRefunded: false }, at)).toEqual({
      $max: { refundedAmount: 25.5 },
      $set: { refundedAt: at },
    });
    expect(refundUpdate({ refundedAmount: 100, fullyRefunded: true }, at)).toEqual({
      $max: { refundedAmount: 100 },
      $set: { refundedAt: at, status: 'refunded' },
    });
  });
});

describe('driver payout account status', () => {
  const account = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'acct_1',
      details_submitted: true,
      charges_enabled: false,
      payouts_enabled: true,
      capabilities: { transfers: 'active' },
      requirements: { currently_due: [], past_due: [] },
      ...overrides,
    }) as any;

  it('shows a finished transfers-only account as ready, even though card charges stay off', () => {
    expect(payoutAccountStatus(account())).toEqual({
      connected: true,
      accountId: 'acct_1',
      detailsSubmitted: true,
      chargesEnabled: false,
      payoutsEnabled: true,
      transfersActive: true,
      ready: true,
      needsMoreInfo: false,
    });
  });

  it.each([
    ['details not sent yet', { details_submitted: false }],
    ['bank payouts not on yet', { payouts_enabled: false }],
    ['transfers still being checked', { capabilities: { transfers: 'pending' } }],
    ['no transfers at all', { capabilities: {} }],
  ])('is not ready when %s', (_label, overrides) => {
    expect(payoutAccountStatus(account(overrides)).ready).toBe(false);
  });

  it('says when Stripe is waiting on the driver', () => {
    expect(payoutAccountStatus(account({ requirements: { currently_due: ['external_account'] } })).needsMoreInfo).toBe(true);
    expect(payoutAccountStatus(account({ requirements: { past_due: ['individual.dob.day'] } })).needsMoreInfo).toBe(true);
    expect(payoutAccountStatus(account({ requirements: undefined })).needsMoreInfo).toBe(false);
  });

  it('tells the driver a payout failed and what to do next', () => {
    expect(payoutFailedNotice('LD-1042', 350)).toEqual({
      title: "Payout couldn't be sent",
      message:
        "Your payout of $350.00 for load LD-1042 couldn't be sent to your payout account. " +
        'Open Settings and finish your Stripe payout account, then let your dispatcher know so they can send it again.',
    });
    expect(payoutFailedNotice(undefined, 12.5).message).toContain('for a delivered load');
  });
});

describe('reward withdrawals', () => {
  const tx = Transaction as unknown as Record<string, jest.Mock>;
  const users = User as unknown as Record<string, jest.Mock>;
  const id = '64b7f0c2a1b2c3d4e5f60718';
  const withdrawal = () => ({
    _id: id,
    userId: 'customer-1',
    amount: 50,
    note: 'Withdrawal request to venmo',
    withdrawalMethod: { type: 'venmo' },
    save: jest.fn().mockResolvedValue(undefined),
  });
  const existing = (doc: unknown) => ({ select: () => ({ lean: () => Promise.resolve(doc) }) });

  const call = (handler: any, req: any) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const res: any = { statusCode: 200 };
      res.status = (code: number) => { res.statusCode = code; return res; };
      res.json = (body: any) => { resolve({ status: res.statusCode, body }); return res; };
      handler({ user: { _id: 'admin-1' }, body: {}, ...req }, res, reject);
    });

  beforeEach(() => {
    jest.clearAllMocks();
    (AuditLog as any).create.mockResolvedValue({});
  });

  it('checks the request: amount, method and where to send it', () => {
    expect(withdrawalRequestFrom({ amount: 25.5, methodType: 'venmo', methodDetails: ' @sam ' })).toEqual({
      ok: true, amount: 25.5, methodType: 'venmo', methodDetails: '@sam',
    });
    expect(withdrawalRequestFrom({ amount: '40', methodType: 'check', methodDetails: '12 Main St' })).toMatchObject({ ok: true, amount: 40 });
    expect(withdrawalRequestFrom({ amount: 0, methodType: 'venmo', methodDetails: 'x' })).toEqual({ ok: false, message: 'Enter an amount greater than $0 to withdraw.' });
    expect(withdrawalRequestFrom({ amount: 'ten', methodType: 'venmo', methodDetails: 'x' })).toEqual({ ok: false, message: 'Enter an amount greater than $0 to withdraw.' });
    expect(withdrawalRequestFrom({ amount: 1.234, methodType: 'venmo', methodDetails: 'x' })).toEqual({ ok: false, message: 'Enter the amount in dollars and cents, for example 25.50.' });
    expect(withdrawalRequestFrom({ amount: 10, methodType: 'cash', methodDetails: 'x' })).toEqual({ ok: false, message: 'Choose how to receive the money: Venmo, PayPal, bank transfer or check.' });
    expect(withdrawalRequestFrom({ amount: 10, methodType: 'paypal', methodDetails: '   ' })).toEqual({ ok: false, message: 'Add where to send the money, for example your Venmo or PayPal username.' });
    expect(withdrawalRequestFrom({ amount: 10, methodType: 'paypal', methodDetails: 'x'.repeat(501) })).toEqual({ ok: false, message: 'Keep the payment details under 500 characters.' });
    expect(withdrawalRequestFrom(undefined)).toMatchObject({ ok: false });
  });

  it('approves a pending withdrawal once and takes the money only if it is still there', async () => {
    tx.findOneAndUpdate.mockResolvedValue(withdrawal());
    users.findOneAndUpdate.mockResolvedValue({ walletBalance: 30, organizationId: 'org-1' });

    const res = await call(adminReferral.approveWithdrawal, { params: { transactionId: id } });

    expect(res.status).toBe(200);
    expect(res.body.data.newBalance).toBe(30);
    expect(tx.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: id, type: 'withdrawal', status: 'pending' },
      { $set: { status: 'completed' } },
      { new: true },
    );
    expect(users.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'customer-1', walletBalance: { $gte: 50 } },
      { $inc: { walletBalance: -50 } },
      { new: true },
    );
  });

  it('refuses a second approval without touching the wallet', async () => {
    tx.findOneAndUpdate.mockResolvedValue(null);
    tx.findById.mockReturnValue(existing({ type: 'withdrawal', status: 'completed' }));

    const res = await call(adminReferral.approveWithdrawal, { params: { transactionId: id } });

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('This withdrawal was already approved or rejected. Refresh to see its current status.');
    expect(users.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('puts the request back when the balance is no longer there', async () => {
    tx.findOneAndUpdate.mockResolvedValue(withdrawal());
    users.findOneAndUpdate.mockResolvedValue(null);
    users.exists.mockResolvedValue({ _id: 'customer-1' });

    const res = await call(adminReferral.approveWithdrawal, { params: { transactionId: id } });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('User no longer has sufficient balance for this withdrawal');
    expect(tx.updateOne).toHaveBeenCalledWith({ _id: id, status: 'completed' }, { $set: { status: 'pending' } });
  });

  it('answers 404 for an unknown or malformed request id', async () => {
    tx.findOneAndUpdate.mockResolvedValue(null);
    tx.findById.mockReturnValue(existing(null));
    expect((await call(adminReferral.approveWithdrawal, { params: { transactionId: id } })).status).toBe(404);
    expect((await call(adminReferral.approveWithdrawal, { params: { transactionId: 'not-an-id' } })).status).toBe(404);
  });

  it('rejects only a pending withdrawal, with a trimmed reason', async () => {
    const doc = withdrawal();
    tx.findOneAndUpdate.mockResolvedValue(doc);
    users.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ organizationId: 'org-1' }) }) });

    const res = await call(adminReferral.rejectWithdrawal, {
      params: { transactionId: id },
      body: { reason: '  Wrong Venmo name  ' },
    });

    expect(res.status).toBe(200);
    expect(tx.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: id, type: 'withdrawal', status: 'pending' },
      { $set: { status: 'rejected' } },
      { new: true },
    );
    expect(doc.note).toBe('Withdrawal request to venmo (REJECTED: Wrong Venmo name)');

    tx.findOneAndUpdate.mockResolvedValue(null);
    tx.findById.mockReturnValue(existing({ type: 'withdrawal', status: 'completed' }));
    expect((await call(adminReferral.rejectWithdrawal, { params: { transactionId: id } })).status).toBe(409);
  });
});
