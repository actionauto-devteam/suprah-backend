/**
 * When a driver sends their verification for review, Suprah AI's super admins
 * and the admins of the driver's own dealership are told, with a link to the
 * driver in Driver Tracker. Models and notifications are stand-ins.
 */
const mockUserFind = jest.fn();
const mockCreateNotification = jest.fn();
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { find: (filter: unknown) => ({ select: () => ({ lean: () => Promise.resolve(mockUserFind(filter)) }) }) },
}));
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: (...args: unknown[]) => mockCreateNotification(...args) },
}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { driverReviewNotice, notifyDriverReviewers } from '../../src/services/driverReviewNotice';

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
