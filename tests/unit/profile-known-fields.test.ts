/**
 * PATCH /api/users/profile saves only the transport contract signature (2026-11-21,
 * narrowed 2026-11-23). The database is a stand-in: nothing here talks to a
 * database.
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
import userController, { PROFILE_UPDATE_FIELDS, SIGNATURE_MAX_LENGTH, profileValueOk } from '../../src/controllers/user.controller';

const users = User as unknown as Record<string, jest.Mock>;
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';

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

describe('the profile route saves only the transport contract signature', () => {
  it('ignores everything else: name, photo, personal details, wallet, payout account, role, permissions and password fields', async () => {
    const select = updated({ signatureDataUrl: SIGNATURE });
    const { error } = await call(userController.updateProfile, {
      user: { _id: 'user-1' },
      body: {
        signatureDataUrl: SIGNATURE,
        name: 'Someone Else',
        avatar: 'https://tracker.example/pixel.png',
        personalInfo: { phone: '+15550000000' },
        theme: 'dark',
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
        passwordHash: 'x',
        passwordResetToken: 'x',
        isActive: true,
      },
    });

    expect(error).toBeUndefined();
    const [id, update, options] = users.findByIdAndUpdate.mock.calls[0];
    expect(id).toBe('user-1');
    expect(Object.keys(update.$set).sort()).toEqual(['signatureDataUrl', 'signatureUpdatedAt']);
    expect(update.$set.signatureDataUrl).toBe(SIGNATURE);
    expect(update.$set.signatureUpdatedAt).toBeInstanceOf(Date);
    expect(options).toEqual({ new: true, runValidators: true });
    // Password and reset-code fields are never sent back.
    expect(select).toHaveBeenCalledWith(expect.stringContaining('-passwordResetToken'));
  });

  it('removing the signature clears its date too', async () => {
    updated({});
    const { error } = await call(userController.updateProfile, { user: { _id: 'user-1' }, body: { signatureDataUrl: null } });
    expect(error).toBeUndefined();
    expect(users.findByIdAndUpdate.mock.calls[0][1]).toEqual({ $set: { signatureDataUrl: null, signatureUpdatedAt: null } });
  });

  it('turns away anything that is not a signature picture, and saves nothing', async () => {
    for (const body of [
      { name: 'Jo' },
      { signatureDataUrl: 'https://tracker.example/pixel.png' },
      { signatureDataUrl: 'javascript:alert(1)' },
      { signatureDataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' },
      { signatureDataUrl: { $ne: '' } },
      { signatureDataUrl: `data:image/png;base64,${'A'.repeat(SIGNATURE_MAX_LENGTH)}` },
    ]) {
      const { error } = await call(userController.updateProfile, { user: { _id: 'user-1' }, body });
      expect(error?.statusCode).toBe(400);
    }
    expect(users.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(PROFILE_UPDATE_FIELDS).toEqual(['signatureDataUrl']);
    // Plain words that fit the only screen that saves here (the driver's transport contract).
    const nothing = await call(userController.updateProfile, { user: { _id: 'user-1' }, body: { name: 'Jo' } });
    expect(nothing.error?.message).toBe('Only your signature is saved here. Change other details on your Profile page.');
    expect(profileValueOk('avatar', 'https://example.com/a.png')).toBe(false);
    expect(profileValueOk('signatureDataUrl', SIGNATURE)).toBe(true);
  });
});
