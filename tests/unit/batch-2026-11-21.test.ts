/**
 * SuprahPay decisions batch (2026-11-21): settings, Finance access, payment
 * rules and dealership payouts. The database, Stripe and notifications are
 * stand-ins: nothing here talks to a database or to Stripe.
 */
jest.mock('../../src/models/SystemConfig.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(), findOneAndUpdate: jest.fn() },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { find: jest.fn(), findById: jest.fn(), findOneAndUpdate: jest.fn() },
}));
jest.mock('../../src/models/AuditLog.model', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../../src/utils/safeNotification', () => ({
  safeCreateNotification: jest.fn(),
  notifyOrgAdmins: jest.fn(),
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findOne: jest.fn(), updateOne: jest.fn(), find: jest.fn(), updateMany: jest.fn(), countDocuments: jest.fn() },
}));
jest.mock('../../src/models/Load.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/trayDevice.service', () => ({ revokeTrayDevicesForEmail: jest.fn() }));
jest.mock('../../src/utils/cache.util', () => ({ invalidateUserCache: jest.fn() }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null, emitToUser: jest.fn(), disconnectUserSockets: jest.fn() }));
// Signs in whoever the test names in the x-test-user header.
jest.mock('../../src/middleware/auth.middleware', () => ({
  __esModule: true,
  default: () => (req: any, _res: any, next: any) => {
    const who = JSON.parse(req.headers['x-test-user'] || 'null');
    if (!who) return next(Object.assign(new Error('signed out'), { statusCode: 401 }));
    req.user = who.user; req.orgId = who.orgId; req.orgRole = who.orgRole;
    next();
  },
}));
// The payment handlers just answer "ok": these tests check who gets through.
jest.mock('../../src/controllers/payment.controller', () => {
  const ok = (_req: any, res: any) => res.json({ ok: true });
  return { __esModule: true, default: new Proxy({}, { get: () => ok }) };
});

import SystemConfig from '../../src/models/SystemConfig.model';
import Organization from '../../src/models/Organization.model';
import AuditLog from '../../src/models/AuditLog.model';
import { notifyOrgAdmins } from '../../src/utils/safeNotification';
import {
  STRIPE_MAX_PAYMENT,
  clearPlatformSettingsCache,
  platformSettingsChange,
  platformSettingsFrom,
  suprahPayOn,
  taxRateSetting,
} from '../../src/services/suprahPaySettings.service';
import * as settingsController from '../../src/controllers/suprahPaySettings.controller';

const configs = SystemConfig as unknown as Record<string, jest.Mock>;
const orgs = Organization as unknown as Record<string, jest.Mock>;

/** Runs a controller and waits for what it answers (or the error it passes on). */
function call(handler: any, req: Record<string, unknown>): Promise<{ res: any; error: any }> {
  return new Promise((resolve) => {
    const res: any = { statusCode: 200 };
    res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
    res.json = jest.fn((body: unknown) => { res.body = body; resolve({ res, error: undefined }); return res; });
    handler({ headers: {}, params: {}, body: {}, query: {}, ...req }, res, (error: unknown) => resolve({ res, error }));
  });
}

/** A stand-in for a database query that ends in .lean() (or .select().lean()). */
const leanResult = (value: unknown) => {
  const q: any = {};
  q.select = jest.fn(() => q);
  q.sort = jest.fn(() => q);
  q.limit = jest.fn(() => q);
  q.lean = jest.fn(() => Promise.resolve(value));
  return q;
};

const ORG_ID = '64b7f0c2a1b2c3d4e5f60718';
const SUPER = { _id: 'sa-1', role: 'super_admin' };
const ADMIN = { _id: 'admin-1', role: 'admin' };
const STAFF = { _id: 'staff-1', role: 'employee' };

beforeEach(() => {
  jest.clearAllMocks();
  clearPlatformSettingsCache();
});

describe('SuprahPay settings: checks before anything is saved', () => {
  it("Suprah's fee is 0–100% with up to 2 decimals; the largest payment is above $0 and within Stripe's limit", () => {
    expect(platformSettingsChange({ feePercent: 2.5 })).toEqual({ ok: true, change: { feePercent: 2.5 } });
    expect(platformSettingsChange({ feePercent: '0', maxPaymentAmount: '25000' })).toEqual({
      ok: true, change: { feePercent: 0, maxPaymentAmount: 25000 },
    });
    for (const bad of [-1, 101, 1.234, 'abc', null, { $gt: '' }, [5]]) {
      expect(platformSettingsChange({ feePercent: bad }).ok).toBe(false);
    }
    for (const bad of [0, -5, 1_000_000, 10.005, { $ne: 1 }]) {
      expect(platformSettingsChange({ maxPaymentAmount: bad }).ok).toBe(false);
    }
    // Only the two known settings are read.
    expect(platformSettingsChange({ isAdmin: true })).toEqual({ ok: false, message: 'Nothing to change.' });
    expect(platformSettingsChange('feePercent=5').ok).toBe(false);
  });

  it('stored settings that are missing or broken fall back to the defaults (0% fee, Stripe’s limit)', () => {
    expect(platformSettingsFrom(undefined)).toEqual({ feePercent: 0, maxPaymentAmount: STRIPE_MAX_PAYMENT });
    expect(platformSettingsFrom({ feePercent: 'lots', maxPaymentAmount: -1 })).toEqual({
      feePercent: 0, maxPaymentAmount: STRIPE_MAX_PAYMENT,
    });
    expect(platformSettingsFrom({ feePercent: 3, maxPaymentAmount: 5000 })).toEqual({ feePercent: 3, maxPaymentAmount: 5000 });
  });

  it('SuprahPay is on when a super admin turns it on, or by default for Suprah Origin dealerships (the pilot)', () => {
    expect(suprahPayOn({ subscription: { tier: 'suprah_origin' } })).toBe(true);
    expect(suprahPayOn({ subscription: { tier: 'suprah_go' } })).toBe(false);
    expect(suprahPayOn({ subscription: { tier: 'suprah_origin' }, suprahPay: { enabled: false } })).toBe(false);
    expect(suprahPayOn({ subscription: { tier: 'suprah_go' }, suprahPay: { enabled: true } })).toBe(true);
    expect(suprahPayOn(null)).toBe(false);
  });

  it('a dealership tax rate is 0–100% with up to 3 decimals', () => {
    expect(taxRateSetting('8.375')).toBe(8.375);
    expect(taxRateSetting(0)).toBe(0);
    for (const bad of [-1, 100.5, 8.3755, 'x', '', { $ne: 1 }, true]) expect(taxRateSetting(bad)).toBeNull();
  });
});

describe('SuprahPay settings: super admins', () => {
  it('saves a checked change and records who made it', async () => {
    configs.findOne.mockReturnValue(leanResult({ value: { feePercent: 0, maxPaymentAmount: 999_999.99 } }));
    const { res, error } = await call(settingsController.updatePlatformSettingsForAdmin, {
      user: SUPER, body: { feePercent: 2.5, role: 'super_admin' },
    });
    expect(error).toBeUndefined();
    expect(configs.findOneAndUpdate).toHaveBeenCalledWith(
      { key: 'suprahpay' },
      { $set: expect.objectContaining({ value: { feePercent: 2.5, maxPaymentAmount: 999_999.99 } }) },
      { upsert: true, new: true },
    );
    expect(res.body.data.feePercent).toBe(2.5);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'System', performedBy: 'sa-1' }));
  });

  it('refuses a value that tries to pass a database command, and saves nothing', async () => {
    const { error } = await call(settingsController.updatePlatformSettingsForAdmin, {
      user: SUPER, body: { feePercent: { $gt: '' } },
    });
    expect(error?.statusCode).toBe(400);
    expect(configs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('turns SuprahPay on for one dealership; a bad id or a non-yes/no value is refused', async () => {
    let r = await call(settingsController.setDealershipSuprahPayForAdmin, { user: SUPER, params: { id: 'abc' }, body: { enabled: true } });
    expect(r.error?.statusCode).toBe(400);
    r = await call(settingsController.setDealershipSuprahPayForAdmin, { user: SUPER, params: { id: ORG_ID }, body: { enabled: 'true' } });
    expect(r.error?.statusCode).toBe(400);
    expect(orgs.findOneAndUpdate).not.toHaveBeenCalled();

    orgs.findOneAndUpdate.mockReturnValue(leanResult({
      _id: ORG_ID, name: 'Test Motors', status: 'active', subscription: { tier: 'suprah_go' }, suprahPay: { enabled: true },
    }));
    r = await call(settingsController.setDealershipSuprahPayForAdmin, { user: SUPER, params: { id: ORG_ID }, body: { enabled: true } });
    expect(r.error).toBeUndefined();
    expect(orgs.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: ORG_ID });
    expect(orgs.findOneAndUpdate.mock.calls[0][1].$set['suprahPay.enabled']).toBe(true);
    expect(r.res.body.data).toMatchObject({ suprahPayOn: true, switchSet: true });
    expect(notifyOrgAdmins).toHaveBeenCalledWith(ORG_ID, 'admin_broadcast', 'SuprahPay is on', expect.any(String), expect.any(Object));
  });
});

describe('SuprahPay settings: dealerships', () => {
  it('staff can read the settings; only admins can edit them', async () => {
    orgs.findById.mockReturnValue(leanResult({ subscription: { tier: 'suprah_origin' }, suprahPay: { defaultTaxRate: 7.25 } }));
    configs.findOne.mockReturnValue(leanResult(null));
    const { res } = await call(settingsController.getDealershipSettings, { user: STAFF, orgId: ORG_ID, orgRole: 'member' });
    expect(res.body.data).toEqual({ enabled: true, defaultTaxRate: 7.25, maxPaymentAmount: 999_999.99, feePercent: 0, canEdit: false, canManagePayments: false });

    const denied = await call(settingsController.updateDealershipSettings, {
      user: STAFF, orgId: ORG_ID, orgRole: 'member', body: { defaultTaxRate: 5 },
    });
    expect(denied.error?.statusCode).toBe(403);
    expect(orgs.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("an admin sets the dealership's default tax rate, only for their own dealership", async () => {
    orgs.findOneAndUpdate.mockReturnValue(leanResult({ subscription: { tier: 'suprah_go' }, suprahPay: { defaultTaxRate: 8.25, enabled: true } }));
    configs.findOne.mockReturnValue(leanResult(null));
    const { res, error } = await call(settingsController.updateDealershipSettings, {
      user: ADMIN, orgId: ORG_ID, orgRole: 'admin', body: { defaultTaxRate: '8.25', organizationId: 'someone-elses' },
    });
    expect(error).toBeUndefined();
    expect(orgs.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: ORG_ID });
    expect(orgs.findOneAndUpdate.mock.calls[0][1].$set['suprahPay.defaultTaxRate']).toBe(8.25);
    expect(res.body.data).toMatchObject({ defaultTaxRate: 8.25, enabled: true, canEdit: true });

    const bad = await call(settingsController.updateDealershipSettings, {
      user: ADMIN, orgId: ORG_ID, orgRole: 'admin', body: { defaultTaxRate: 120 },
    });
    expect(bad.error?.statusCode).toBe(400);
  });
});

// ─── Finance access ──────────────────────────────────────────────────────────
import express from 'express';
import request from 'supertest';
import User from '../../src/models/User.model';
import paymentRoutes from '../../src/routes/payment.routes';
import { crmUserHasFinanceAccess, hasFinanceAccess } from '../../src/utils/financeAccess';
import { updateMemberFinanceAccess } from '../../src/controllers/organization.controller';

const users = User as unknown as Record<string, jest.Mock>;
/** A stand-in query you can .select() / .lean() / await. */
const doc = (value: unknown) => {
  const q: any = {};
  q.select = jest.fn(() => q);
  q.lean = jest.fn(() => Promise.resolve(value));
  q.then = (done: any, failed: any) => Promise.resolve(value).then(done, failed);
  return q;
};

describe('Finance access: who can send, cancel and refund', () => {
  it('admins always can; staff only with Finance access for this dealership; customers never', () => {
    expect(hasFinanceAccess({ role: 'super_admin' }, ORG_ID)).toBe(true);
    expect(hasFinanceAccess({ role: 'admin' }, ORG_ID)).toBe(true);
    expect(hasFinanceAccess({ role: 'employee' }, ORG_ID, 'admin')).toBe(true);
    expect(hasFinanceAccess({ role: 'employee', financeOrganizationIds: [ORG_ID] }, ORG_ID)).toBe(true);
    expect(hasFinanceAccess({ role: 'employee', financeOrganizationIds: ['64b7f0c2a1b2c3d4e5f6ffff'] }, ORG_ID)).toBe(false);
    expect(hasFinanceAccess({ role: 'employee' }, ORG_ID)).toBe(false);
    expect(hasFinanceAccess({ role: 'customer', financeOrganizationIds: [ORG_ID] }, ORG_ID)).toBe(false);
    expect(hasFinanceAccess(null, ORG_ID)).toBe(false);
  });

  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentRoutes);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ message: err.message }));
  const as = (user: unknown, orgRole = 'member') => JSON.stringify({ user, orgId: ORG_ID, orgRole });

  it('the server refuses staff without Finance access, whatever the website shows', async () => {
    const staff = as({ _id: 's1', role: 'employee' });
    const attempts: Array<['post' | 'patch', string]> = [
      ['post', '/api/payments'],
      ['post', `/api/payments/${ORG_ID}/refund`],
      ['post', `/api/payments/${ORG_ID}/cancel`],
      ['post', `/api/payments/${ORG_ID}/request`],
      ['patch', `/api/payments/${ORG_ID}`],
    ];
    for (const [method, path] of attempts) {
      const res = await request(app)[method](path).set('x-test-user', staff).send({});
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/Finance access/);
    }
    // Viewing stays open to every staff member.
    expect((await request(app).get('/api/payments').set('x-test-user', staff)).status).toBe(200);
  });

  it('admins and staff with Finance access get through; customers never do', async () => {
    const finance = as({ _id: 's2', role: 'employee', financeOrganizationIds: [ORG_ID] });
    const admin = as({ _id: 'a1', role: 'admin' }, 'admin');
    for (const who of [finance, admin]) {
      expect((await request(app).post(`/api/payments/${ORG_ID}/refund`).set('x-test-user', who).send({})).status).toBe(200);
    }
    const customer = as({ _id: 'c1', role: 'customer', financeOrganizationIds: [ORG_ID] });
    expect((await request(app).post('/api/payments').set('x-test-user', customer).send({})).status).toBe(403);
  });

  it('CRM accounts: a CRM admin can; anyone else needs Finance access on their website account', async () => {
    expect(await crmUserHasFinanceAccess({ role: 'admin', organizationId: ORG_ID })).toBe(true);
    users.findOne.mockReturnValue(doc({ role: 'employee', financeOrganizationIds: [ORG_ID] }));
    expect(await crmUserHasFinanceAccess({ role: 'manager', email: ' Staff@Example.com ', organizationId: ORG_ID })).toBe(true);
    expect(users.findOne).toHaveBeenCalledWith({ email: 'staff@example.com', organizationId: ORG_ID });
    users.findOne.mockReturnValue(doc({ role: 'employee' }));
    expect(await crmUserHasFinanceAccess({ role: 'employee', email: 'staff@example.com', organizationId: ORG_ID })).toBe(false);
    expect(await crmUserHasFinanceAccess({ role: 'manager', organizationId: ORG_ID })).toBe(false);
  });
});

describe('Finance access: given on the Members page by dealership admins', () => {
  const MEMBER_ID = '64b7f0c2a1b2c3d4e5f60999';
  const org = { name: 'Test Motors', ownerId: { toString: () => 'owner-1' } };

  it('a staff member cannot give it; bad ids or values are refused', async () => {
    orgs.findById.mockReturnValue(doc(org));
    let r = await call(updateMemberFinanceAccess, {
      user: { _id: 'staff-1', role: 'employee' }, orgId: ORG_ID, orgRole: 'member',
      params: { id: ORG_ID, userId: MEMBER_ID }, body: { enabled: true },
    });
    expect(r.error?.statusCode).toBe(403);
    r = await call(updateMemberFinanceAccess, { user: ADMIN, orgId: ORG_ID, orgRole: 'admin', params: { id: ORG_ID, userId: 'x' }, body: { enabled: true } });
    expect(r.error?.statusCode).toBe(400);
    r = await call(updateMemberFinanceAccess, { user: ADMIN, orgId: ORG_ID, orgRole: 'admin', params: { id: ORG_ID, userId: MEMBER_ID }, body: { enabled: 'yes' } });
    expect(r.error?.statusCode).toBe(400);
    expect(users.updateOne).not.toHaveBeenCalled();
  });

  it('an admin gives it to a staff member of their own dealership', async () => {
    orgs.findById.mockReturnValue(doc(org));
    users.findOne.mockReturnValue(doc({ _id: MEMBER_ID, name: 'Sam', role: 'employee', organizationRole: 'member', financeOrganizationIds: [] }));
    const { res, error } = await call(updateMemberFinanceAccess, {
      user: ADMIN, orgId: ORG_ID, orgRole: 'admin', params: { id: ORG_ID, userId: MEMBER_ID }, body: { enabled: true },
    });
    expect(error).toBeUndefined();
    expect(users.findOne).toHaveBeenCalledWith({ _id: MEMBER_ID, organizationId: ORG_ID });
    expect(users.updateOne).toHaveBeenCalledWith({ _id: MEMBER_ID, organizationId: ORG_ID }, { $addToSet: { financeOrganizationIds: ORG_ID } });
    expect(res.body.data.hasFinanceAccess).toBe(true);
  });

  it('admins already have it, so it is not given to them', async () => {
    orgs.findById.mockReturnValue(doc(org));
    users.findOne.mockReturnValue(doc({ _id: MEMBER_ID, role: 'admin', organizationRole: 'admin' }));
    const { error } = await call(updateMemberFinanceAccess, {
      user: ADMIN, orgId: ORG_ID, orgRole: 'admin', params: { id: ORG_ID, userId: MEMBER_ID }, body: { enabled: true },
    });
    expect(error?.statusCode).toBe(400);
    expect(users.updateOne).not.toHaveBeenCalled();
  });
});
