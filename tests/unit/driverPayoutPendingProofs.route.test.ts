/**
 * The pending-proofs list shows drivers' names, emails and delivery photos,
 * so only the organization's staff may open it. The controller is replaced
 * with a stand-in so this checks the route's own guard; no database is used.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/auth.middleware', () => ({
  __esModule: true,
  default: () => (req: any, _res: any, next: any) => {
    req.user = { _id: 'user-1', role: req.headers['x-test-role'] };
    next();
  },
}));
jest.mock('../../src/middleware/org.middleware', () => ({
  requireOrg: (req: any, _res: any, next: any) => {
    req.orgId = 'org-1';
    next();
  },
}));
jest.mock('../../src/controllers/driverPayout.controller', () => {
  const ok = (_req: any, res: any) => res.status(200).json({ ok: true });
  return {
    __esModule: true,
    default: {
      initiateDriverOnboarding: ok,
      getDriverConnectStatus: ok,
      getMyPayouts: ok,
      getDeliverableLoads: ok,
      getPendingProofs: ok,
      getOrgAdmins: ok,
      getPayoutStats: ok,
      getPayouts: ok,
      createPayout: ok,
    },
  };
});

import driverPayoutRoutes from '../../src/routes/driverPayout.routes';

const app = express();
app.use('/api/driver-payouts', driverPayoutRoutes);
app.use((err: any, _req: any, res: any, _next: any) =>
  res.status(err.statusCode || 500).json({ message: err.message }),
);

const pendingProofsAs = (role: string) =>
  request(app).get('/api/driver-payouts/pending-proofs').set('x-test-role', role);

describe('GET /api/driver-payouts/pending-proofs', () => {
  it.each(['customer', 'driver'])('refuses a %s account', async (role) => {
    const res = await pendingProofsAs(role);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Only your organization's staff can view driver payouts.");
  });

  it.each(['employee', 'admin', 'super_admin'])('lets %s staff through', async (role) => {
    const res = await pendingProofsAs(role);
    expect(res.status).toBe(200);
  });
});
