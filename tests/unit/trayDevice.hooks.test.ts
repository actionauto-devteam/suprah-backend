const mockRevokeUser = jest.fn();
const mockRevokeEmail = jest.fn();
const mockCrmFindOne = jest.fn();
const mockOrgFindById = jest.fn();
const mockUserExists = jest.fn();
const mockUserFindByIdAndUpdate = jest.fn();
const mockUserFindById = jest.fn();

jest.mock('../../src/services/trayDevice.service', () => ({
  revokeUserTrayDevices: mockRevokeUser,
  revokeTrayDevicesForEmail: mockRevokeEmail,
}));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findOne: mockCrmFindOne } }));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { exists: mockUserExists, findByIdAndUpdate: mockUserFindByIdAndUpdate, findById: mockUserFindById },
}));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: mockOrgFindById } }));
jest.mock('../../src/models/TimeLog.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Absence.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/EmployeeLocation.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/AgentHeartbeat.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/middleware/crmAuth.middleware', () => ({ generateCrmToken: jest.fn(), CRM_TOKEN_COOKIE: 'crm_token' }));
jest.mock('../../src/services/email.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: jest.fn(), emitToShiftBoard: jest.fn(), emitToUser: jest.fn() }));
jest.mock('../../src/services/storage.service', () => ({ storageService: {} }));
jest.mock('../../src/socket/supraspace.socket', () => ({ getIO: jest.fn() }));
jest.mock('../../src/services/crmPush.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/timeLogEngine', () => ({ buildSessions: jest.fn(), buildBreakSessions: jest.fn() }));
jest.mock('../../src/utils/departmentSync.util', () => ({ cascadeDepartmentToLinkedUser: jest.fn(), cascadeEmailToLinkedUser: jest.fn() }));
jest.mock('../../src/services/department.service', () => ({ normalizeDepartmentValue: jest.fn(), getDefaultDepartmentKey: jest.fn() }));
jest.mock('../../src/config/departmentMonitoring', () => ({
  isMainMonitorOnlyDept: jest.fn(),
  isLocationRequiredForUser: jest.fn(),
  isIdleDetectionExemptDept: jest.fn(),
  isMobileMonitoringDept: jest.fn(),
  isIdleVideoProofEnabled: jest.fn(),
  resolveMonitoringMode: jest.fn(),
}));
jest.mock('../../src/utils/monitoringMode.util', () => ({ resolveScreenshotsRequired: jest.fn() }));
jest.mock('../../src/services/shiftAlerts.service', () => ({ fireShiftAlert: jest.fn() }));
jest.mock('../../src/utils/crossIdentityShift.util', () => ({ findOpenShiftOnOtherIdentity: jest.fn() }));
jest.mock('../../src/utils/employeeId.util', () => ({ resolveNextEmployeeId: jest.fn() }));
jest.mock('../../src/utils/cache.util', () => ({ invalidateUserCache: jest.fn() }));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: jest.fn(), notifyOrgAdmins: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/config/subscriptionTiers', () => ({
  isValidTier: jest.fn(),
  isPurchasableTier: jest.fn(),
  TIER_SEAT_LIMITS: {},
  TIER_LABELS: {},
}));

import crmController from '../../src/controllers/crm.controller';
import { removeMember } from '../../src/controllers/organization.controller';

const run = async (handler: (...args: any[]) => unknown, req: Record<string, unknown>) => {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const next = jest.fn();
  handler(req, { json, status, cookie: jest.fn() }, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, status, next };
};

const admin = { _id: { toString: () => 'admin1' }, role: 'admin', organizationId: 'org1' };
const targetUser = (overrides: Record<string, unknown> = {}) => ({
  _id: 'u2',
  isActive: true,
  isOffboarded: false,
  save: jest.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('tray device revocation hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRevokeUser.mockResolvedValue(1);
    mockRevokeEmail.mockResolvedValue(1);
  });

  describe('toggleUserStatus', () => {
    it('revokes the tray devices when an account is deactivated', async () => {
      mockCrmFindOne.mockResolvedValue(targetUser({ isActive: true }));
      const { next } = await run(crmController.toggleUserStatus, { crmUser: admin, params: { id: 'u2' } });
      expect(next).not.toHaveBeenCalled();
      expect(mockRevokeUser).toHaveBeenCalledWith('u2', 'user_deactivated');
    });

    it('does not revoke anything when an account is reactivated', async () => {
      mockCrmFindOne.mockResolvedValue(targetUser({ isActive: false }));
      await run(crmController.toggleUserStatus, { crmUser: admin, params: { id: 'u2' } });
      expect(mockRevokeUser).not.toHaveBeenCalled();
    });

    it('still succeeds when the revocation itself fails', async () => {
      mockCrmFindOne.mockResolvedValue(targetUser({ isActive: true }));
      mockRevokeUser.mockRejectedValue(new Error('db down'));
      const { next, json } = await run(crmController.toggleUserStatus, { crmUser: admin, params: { id: 'u2' } });
      expect(next).not.toHaveBeenCalled();
      expect(json).toHaveBeenCalled();
    });
  });

  describe('offboardUser', () => {
    it('revokes the tray devices on offboarding', async () => {
      mockCrmFindOne.mockResolvedValue(targetUser());
      const { next } = await run(crmController.offboardUser, { crmUser: admin, params: { id: 'u2' } });
      expect(next).not.toHaveBeenCalled();
      expect(mockRevokeUser).toHaveBeenCalledWith('u2', 'user_offboarded');
    });

    it('does nothing for an already offboarded account', async () => {
      mockCrmFindOne.mockResolvedValue(targetUser({ isOffboarded: true }));
      const { next } = await run(crmController.offboardUser, { crmUser: admin, params: { id: 'u2' } });
      expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 409 });
      expect(mockRevokeUser).not.toHaveBeenCalled();
    });
  });

  describe('ordinary password resets never revoke a registered computer', () => {
    it('admin reset', async () => {
      const user = targetUser({ password: 'old' });
      mockCrmFindOne.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
      const { next } = await run(crmController.resetPassword, { crmUser: admin, params: { id: 'u2' }, body: { newPassword: 'longenough1' } });
      expect(next).not.toHaveBeenCalled();
      expect(user.save).toHaveBeenCalled();
      expect(mockRevokeUser).not.toHaveBeenCalled();
      expect(mockRevokeEmail).not.toHaveBeenCalled();
    });

    it('self-service reset with a valid code', async () => {
      const user = targetUser({ resetOtp: '123456', resetOtpExpiry: new Date(Date.now() + 60_000) });
      mockCrmFindOne.mockReturnValue({ select: jest.fn().mockResolvedValue(user) });
      const { next } = await run(crmController.confirmResetPassword, {
        body: { email: 'a@example.com', otp: '123456', newPassword: 'longenough1' },
      });
      expect(next).not.toHaveBeenCalled();
      expect(user.save).toHaveBeenCalled();
      expect(mockRevokeUser).not.toHaveBeenCalled();
      expect(mockRevokeEmail).not.toHaveBeenCalled();
    });
  });

  describe('organization membership removal', () => {
    const request = { params: { id: 'org1', userId: 'u2' }, user: { _id: { toString: () => 'admin1' }, role: 'user' }, orgRole: 'admin', orgId: 'org1' };

    beforeEach(() => {
      mockOrgFindById.mockResolvedValue({ ownerId: { toString: () => 'owner1' }, name: 'Org' });
      mockUserExists.mockResolvedValue({ _id: 'u2' });
      mockUserFindByIdAndUpdate.mockResolvedValue({});
    });

    it('revokes the linked computers by email after the member is removed', async () => {
      mockUserFindById.mockResolvedValue({ _id: { toString: () => 'u2' }, email: 'Ana@Example.com' });
      const { next } = await run(removeMember, request);
      expect(next).not.toHaveBeenCalled();
      expect(mockRevokeEmail).toHaveBeenCalledWith('Ana@Example.com', 'org1', 'org_membership_removed');
    });

    it('revokes nothing when the target is not a member', async () => {
      mockUserExists.mockResolvedValue(null);
      await run(removeMember, request);
      expect(mockUserFindByIdAndUpdate).not.toHaveBeenCalled();
      expect(mockRevokeEmail).not.toHaveBeenCalled();
    });
  });
});
