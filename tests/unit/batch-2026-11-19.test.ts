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
