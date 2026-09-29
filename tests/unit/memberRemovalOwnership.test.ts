const mockOrgFindById = jest.fn();
const mockUserExists = jest.fn();
const mockUserFindOneAndUpdate = jest.fn();
const mockUserFindById = jest.fn();
const mockLoadFind = jest.fn();
const mockLoadUpdateMany = jest.fn();
const mockLoadDeleteMany = jest.fn();

jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: mockOrgFindById } }));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { exists: mockUserExists, findOneAndUpdate: mockUserFindOneAndUpdate, findById: mockUserFindById },
}));
jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: { find: mockLoadFind, updateMany: mockLoadUpdateMany, deleteMany: mockLoadDeleteMany },
}));
jest.mock('../../src/services/trayDevice.service', () => ({ revokeTrayDevicesForEmail: jest.fn().mockResolvedValue(0) }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: jest.fn(), disconnectUserSockets: jest.fn() }));
jest.mock('../../src/utils/cache.util', () => ({ invalidateUserCache: jest.fn() }));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: jest.fn(), notifyOrgAdmins: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn().mockResolvedValue({}) } }));
jest.mock('../../src/config/subscriptionTiers', () => ({ isValidTier: jest.fn(), isPurchasableTier: jest.fn(), TIER_SEAT_LIMITS: {}, TIER_LABELS: {} }));

import mongoose from 'mongoose';
import { removeMember } from '../../src/controllers/organization.controller';

const chain = (rows: unknown[]) => ({ select: () => ({ session: () => ({ lean: () => Promise.resolve(rows) }) }) });

describe('removing a member who is responsible for active loads (DT-06)', () => {
  const adminId = { toString: () => 'admin1' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgFindById.mockResolvedValue({ ownerId: { toString: () => 'owner1' }, name: 'Org' });
    mockUserExists.mockResolvedValue({ _id: 'u2' });
    mockUserFindOneAndUpdate.mockResolvedValue({ _id: 'u2' });
    mockUserFindById.mockResolvedValue(null);
    mockLoadUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    // Loads the member created: none. Loads they are responsible for: one.
    mockLoadFind.mockImplementation((filter: any) =>
      chain(filter.dispatchOwnerId ? [{ _id: 'load1', loadNumber: 'LD-20260927-001' }] : []),
    );
    jest.spyOn(mongoose, 'startSession').mockResolvedValue({
      withTransaction: async (fn: () => Promise<unknown>) => fn(),
      endSession: jest.fn(),
    } as any);
  });

  it('transfers responsibility to the admin removing them and says so', async () => {
    const json = jest.fn();
    const status = jest.fn(() => ({ json }));
    const next = jest.fn();
    removeMember(
      { params: { id: 'org1', userId: 'u2' }, user: { _id: adminId, role: 'user' }, orgRole: 'admin', orgId: 'org1' } as any,
      { status, json } as any,
      next,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    expect(mockLoadUpdateMany).toHaveBeenCalledWith(
      { _id: { $in: ['load1'] }, dispatchOwnerId: 'u2' },
      { $set: { dispatchOwnerId: adminId } },
      expect.objectContaining({ timestamps: false }),
    );
    expect(status).toHaveBeenCalledWith(200);
    const body = json.mock.calls[0][0];
    expect(body.message).toContain('You are now the responsible dispatcher for load LD-20260927-001');
    expect(body.transferredLoadNumbers).toEqual(['LD-20260927-001']);
  });

  it('changes nothing when the member is not responsible for any active load', async () => {
    mockLoadFind.mockImplementation(() => chain([]));
    const json = jest.fn();
    removeMember(
      { params: { id: 'org1', userId: 'u2' }, user: { _id: adminId, role: 'user' }, orgRole: 'admin', orgId: 'org1' } as any,
      { status: jest.fn(() => ({ json })), json } as any,
      jest.fn(),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockLoadUpdateMany).not.toHaveBeenCalled();
    expect(json.mock.calls[0][0].message).toBe('Member removed');
  });
});
