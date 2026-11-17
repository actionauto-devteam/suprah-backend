// Tests from the November 3, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

// Fakes from driverReviewNotice.test.ts
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { find: (filter: unknown) => ({ select: () => ({ lean: () => Promise.resolve(mockUserFind(filter)) }) }) },
}));
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: (...args: unknown[]) => mockCreateNotification(...args) },
}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

// Used by the fakes from driverReviewNotice.test.ts (above the imports, as in that file)
const mockUserFind = jest.fn();
const mockCreateNotification = jest.fn();

import { loadContactIds, pickLoadContact } from '../../src/services/dispatchChatContact';
import { driverReviewNotice, notifyDriverReviewers } from '../../src/services/driverReviewNotice';

describe('dispatchChatContact.test.ts', () => {
  /**
   * Who a driver reaches in Dispatch Chat about a load: the load's dispatcher,
   * then whoever created it, then the dealership's admin, so a switched-off
   * account never leaves the driver with "try again later".
   */
  const OWNER = '64b0000000000000000000d1';
  const CREATOR = '64b0000000000000000000d2';
  const ORG = 'org-1';

  type Staff = { id: string; organizationId: string };
  const staff = (id: string, organizationId = ORG): Staff => ({ id, organizationId });
  const sameDealership = (user: Staff) => user.organizationId === ORG;
  const admin = staff('admin-1');

  describe('loadContactIds', () => {
    it("lists the load's dispatcher first, then whoever created it, once each", () => {
      expect(loadContactIds({ dispatchOwnerId: OWNER, createdBy: CREATOR })).toEqual([OWNER, CREATOR]);
      expect(loadContactIds({ dispatchOwnerId: CREATOR, createdBy: CREATOR })).toEqual([CREATOR]);
      expect(loadContactIds({ createdBy: CREATOR })).toEqual([CREATOR]);
    });

    it('skips missing and invalid ids', () => {
      expect(loadContactIds({ dispatchOwnerId: 'nope', createdBy: null })).toEqual([]);
      expect(loadContactIds(null)).toEqual([]);
    });
  });

  describe('pickLoadContact', () => {
    const load = { dispatchOwnerId: OWNER, createdBy: CREATOR };

    it("reaches the load's dispatcher when their account is active", () => {
      const active = new Map([[OWNER, staff(OWNER)], [CREATOR, staff(CREATOR)]]);
      expect(pickLoadContact(load, active, admin, sameDealership)).toEqual(staff(OWNER));
    });

    it('reaches whoever created the load when the dispatcher is switched off', () => {
      const active = new Map([[CREATOR, staff(CREATOR)]]);
      expect(pickLoadContact(load, active, admin, sameDealership)).toEqual(staff(CREATOR));
    });

    it("reaches the dealership's admin when nobody on the load can take the chat", () => {
      expect(pickLoadContact(load, new Map(), admin, sameDealership)).toEqual(admin);
      // Someone who moved to another dealership doesn't count.
      const moved = new Map([[OWNER, staff(OWNER, 'other-org')]]);
      expect(pickLoadContact(load, moved, admin, sameDealership)).toEqual(admin);
    });

    it('returns nobody when there is no admin either', () => {
      expect(pickLoadContact(load, new Map(), null, sameDealership)).toBeNull();
      expect(pickLoadContact(load, new Map(), staff('admin-2', 'other-org'), sameDealership)).toBeNull();
    });
  });
});

describe('driverReviewNotice.test.ts', () => {
  /**
   * When a driver sends their verification for review, Suprah AI's super admins
   * and the admins of the driver's own dealership are told, with a link to the
   * driver in Driver Tracker. Models and notifications are stand-ins.
   */
  const DRIVER = '64b0000000000000000000e1';
  const ORG = '64b0000000000000000000e2';

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateNotification.mockResolvedValue(undefined);
    mockUserFind.mockReturnValue([{ _id: 'super-1' }, { _id: 'admin-1', organizationId: ORG }]);
  });

  describe('driverReviewNotice', () => {
    it('says who is waiting and what to do, in plain English', () => {
      expect(driverReviewNotice('Maria Santos')).toEqual({
        title: 'Driver Ready for Review',
        message: 'Maria Santos sent their driver verification for review. Open Driver Tracker to check their documents and approve them.',
      });
      expect(driverReviewNotice('').message.startsWith('A driver sent')).toBe(true);
    });
  });

  describe('notifyDriverReviewers', () => {
    it("tells the super admins and the admins of the driver's own dealership", async () => {
      expect(await notifyDriverReviewers({ _id: DRIVER, name: 'Maria', organizationId: ORG })).toBe(2);
      expect(mockUserFind.mock.calls[0][0]).toEqual({
        $or: [{ role: 'super_admin' }, { organizationId: ORG, role: 'admin' }],
        isActive: { $ne: false },
      });
      expect(mockCreateNotification).toHaveBeenCalledTimes(2);
      expect(mockCreateNotification.mock.calls[0][0]).toMatchObject({
        userId: 'super-1',
        organizationId: ORG,
        type: 'driver_request',
        metadata: { driverId: DRIVER, suppressActions: true, route: `/driver-tracker?driverId=${DRIVER}` },
      });
    });

    it("tells only the super admins when the driver didn't join through a dealership", async () => {
      mockUserFind.mockReturnValue([{ _id: 'super-1' }]);
      await notifyDriverReviewers({ _id: DRIVER, name: 'Maria' });
      expect(mockUserFind.mock.calls[0][0].$or).toEqual([{ role: 'super_admin' }]);
      expect(mockCreateNotification.mock.calls[0][0].organizationId).toBe('global');
    });

    it("never fails the driver's submission", async () => {
      mockCreateNotification.mockRejectedValue(new Error('down'));
      await expect(notifyDriverReviewers({ _id: DRIVER, name: 'Maria' })).resolves.toBe(2);
      mockUserFind.mockImplementation(() => { throw new Error('db down'); });
      await expect(notifyDriverReviewers({ _id: DRIVER })).resolves.toBe(0);
      expect(await notifyDriverReviewers({ _id: 'not-an-id' })).toBe(0);
    });
  });
});
