/**
 * PATCH /api/users/profile saves only known profile fields (2026-11-21).
 * The database is a stand-in: nothing here talks to a database.
 */
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findByIdAndUpdate: jest.fn() },
}));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/activity.service', () => ({
  __esModule: true,
  default: { logProfileUpdate: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../../src/utils/cache.util', () => ({ invalidateUserCache: jest.fn() }));

import User from '../../src/models/User.model';
import userController, { PROFILE_UPDATE_FIELDS, profileValueOk } from '../../src/controllers/user.controller';

const users = User as unknown as Record<string, jest.Mock>;

function call(handler: any, req: Record<string, unknown>): Promise<{ res: any; error: any }> {
  return new Promise((resolve) => {
    const res: any = { statusCode: 200 };
    res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
    res.json = jest.fn((body: unknown) => { res.body = body; resolve({ res, error: undefined }); return res; });
    handler({ headers: {}, params: {}, body: {}, get: () => 'test', ip: '127.0.0.1', ...req }, res, (error: unknown) => resolve({ res, error }));
  });
}

const updated = (fields: Record<string, unknown>) => {
  const select = jest.fn(() => Promise.resolve({ _id: 'user-1', organizationId: 'org-1', ...fields }));
  users.findByIdAndUpdate.mockReturnValue({ select });
  return select;
};

beforeEach(() => jest.clearAllMocks());

describe('profile changes save only known fields', () => {
  it('ignores wallet balance, earnings, payout account, referral code, role, permissions, suspension, monitoring and password fields', async () => {
    const select = updated({ signatureDataUrl: 'data:image/png;base64,AAAA' });
    const { error } = await call(userController.updateProfile, {
      user: { _id: 'user-1' },
      body: {
        signatureDataUrl: 'data:image/png;base64,AAAA',
        walletBalance: 100000,
        totalEarned: 100000,
        stripeConnectAccountId: 'acct_someone_else',
        referralCode: 'TAKEN',
        role: 'super_admin',
        organizationRole: 'admin',
        dispatcherOrganizationIds: ['org-1'],
        financeOrganizationIds: ['org-1'],
        suspendedByOffboard: false,
        monitoringModeOverride: 'off',
        locationRequiredOverride: false,
        passwordHash: 'x',
        passwordResetToken: 'x',
        isActive: true,
      },
    });

    expect(error).toBeUndefined();
    expect(users.findByIdAndUpdate).toHaveBeenCalledWith(
      'user-1',
      { $set: { signatureDataUrl: 'data:image/png;base64,AAAA' } },
      { new: true, runValidators: true },
    );
    // Password and reset-code fields are never sent back.
    expect(select).toHaveBeenCalledWith(expect.stringContaining('-passwordResetToken'));
  });

  it('still saves the name, photo, theme, status and personal info', async () => {
    updated({});
    await call(userController.updateProfile, {
      user: { _id: 'user-1' },
      body: { name: 'Jo', avatar: null, theme: 'dark', onlineStatus: 'online', customStatus: null, personalInfo: { city: 'Provo' } },
    });
    expect(users.findByIdAndUpdate.mock.calls[0][1]).toEqual({
      $set: { name: 'Jo', avatar: null, theme: 'dark', onlineStatus: 'online', customStatus: null, personalInfo: { city: 'Provo' } },
    });
  });

  it('turns away a wrong kind of value and saves nothing', async () => {
    const { error } = await call(userController.updateProfile, { user: { _id: 'user-1' }, body: { name: { $ne: '' } } });
    expect(error?.statusCode).toBe(400);
    expect(users.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(profileValueOk('personalInfo', ['x'])).toBe(false);
    expect(profileValueOk('name', null)).toBe(false);
    expect(PROFILE_UPDATE_FIELDS).not.toContain('walletBalance' as never);
  });
});
