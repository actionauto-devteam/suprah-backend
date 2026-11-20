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
    expect(res.body.data).toEqual({ enabled: true, defaultTaxRate: 7.25, maxPaymentAmount: 999_999.99, feePercent: 0, canEdit: false });

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
