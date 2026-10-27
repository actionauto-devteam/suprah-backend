/**
 * Only customer accounts can send shipping requests from the customer portal,
 * and one customer can't flood a dealership with them. The controller is a
 * stand-in so this checks the route itself; no database is used.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth.middleware', () => ({
  __esModule: true,
  default: () => (req: any, _res: any, next: any) => {
    req.user = { _id: req.headers['x-test-user'] ?? 'user-1', role: req.headers['x-test-role'] };
    next();
  },
}));
jest.mock('../../src/controllers/quote.controller', () => ({
  __esModule: true,
  default: { createCustomerQuoteRequest: (_req: any, res: any) => res.status(201).json({ ok: true }) },
}));

import customerQuoteRequestRoutes from '../../src/routes/customerQuoteRequest.routes';

const app = express();
app.use('/api/quote-requests', customerQuoteRequestRoutes);
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(err.statusCode || 500).json({ message: err.message }),
);

const sendAs = (role: string, user = `${role}-1`) =>
  request(app).post('/api/quote-requests').set('x-test-role', role).set('x-test-user', user);

beforeEach(() => {
  process.env.SKIP_RATE_LIMIT = 'false';
});

afterAll(() => {
  delete process.env.SKIP_RATE_LIMIT;
});

describe('POST /api/quote-requests', () => {
  it('lets a customer send a request', async () => {
    expect((await sendAs('customer')).status).toBe(201);
  });

  it.each(['employee', 'admin', 'driver'])('points %s accounts to the Transportation page instead', async (role) => {
    const res = await sendAs(role);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Shipping requests here are for customer accounts. Staff create quotes from the Transportation page.');
  });

  it('allows 20 requests an hour per customer, then explains the wait', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await sendAs('customer', 'busy-customer')).status).toBe(201);
    }
    const limited = await sendAs('customer', 'busy-customer');
    expect(limited.status).toBe(429);
    expect(limited.body.message).toBe(
      "You've asked for a lot of shipping quotes in the last hour. Wait a while, then try again. If this keeps happening, contact Suprah AI support at support@suprahai.com.",
    );
    expect((await sendAs('customer', 'another-customer')).status).toBe(201);
  });
});
