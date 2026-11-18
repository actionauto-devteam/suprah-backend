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

import paymentRoutes from '../../src/routes/payment.routes';
import {
  refundRequestFor,
  refundStateFromCharge,
  refundUpdate,
  remainingRefundable,
} from '../../src/utils/paymentRefund';

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
