const mockTimeLogFind = jest.fn();
const mockCrmFindById = jest.fn();
const mockLocFindOne = jest.fn();
const mockStateFindById = jest.fn();

jest.mock('../../src/models/TimeLog.model', () => ({ __esModule: true, default: { find: mockTimeLogFind } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findById: mockCrmFindById } }));
jest.mock('../../src/models/EmployeeLocation.model', () => ({ __esModule: true, default: { findOne: mockLocFindOne } }));
jest.mock('../../src/models/MonitoringDeviceState.model', () => ({ __esModule: true, default: { findById: mockStateFindById } }));

import {
  getActiveDevice,
  getOpenShiftStart,
  isDesktopActiveForUserId,
  isMobileActiveWithFreshPhone,
} from '../../src/utils/monitoringDeviceState.util';

const savedEnv = { ...process.env };
const START = new Date('2026-09-25T10:00:00.000Z');
const lean = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });
const logs = (...entries: Array<[string, string]>) => ({
  sort: () => ({
    select: () => ({ lean: () => Promise.resolve(entries.map(([type, at]) => ({ type, timestamp: new Date(at) }))) }),
  }),
});

describe('monitoringDeviceState.util', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...savedEnv };
    delete process.env.MON_DEVICE_SWITCH;
    delete process.env.MON_DEVICE_SWITCH_DISABLED;
    mockTimeLogFind.mockReturnValue(logs(['time-in', START.toISOString()]));
    mockCrmFindById.mockImplementation(() => lean({ deviceSwitchOverride: 'on' }));
    mockStateFindById.mockImplementation(() => lean({ activeDevice: 'desktop', shiftStartedAt: START }));
    mockLocFindOne.mockImplementation(() => lean({ _id: 'loc1' }));
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  describe('getOpenShiftStart', () => {
    it('returns the latest time-in of an open shift', async () => {
      mockTimeLogFind.mockReturnValue(logs(['time-in', '2026-09-24T09:00:00.000Z'], ['time-out', '2026-09-24T17:00:00.000Z'], ['time-in', START.toISOString()]));
      expect((await getOpenShiftStart('u1'))?.toISOString()).toBe(START.toISOString());
    });

    it('returns null once the shift was closed or when there are no logs', async () => {
      mockTimeLogFind.mockReturnValue(logs(['time-in', START.toISOString()], ['time-out', '2026-09-25T11:00:00.000Z']));
      expect(await getOpenShiftStart('u1')).toBeNull();
      mockTimeLogFind.mockReturnValue(logs());
      expect(await getOpenShiftStart('u1')).toBeNull();
    });

    it('a break does not end the shift', async () => {
      mockTimeLogFind.mockReturnValue(logs(['time-in', START.toISOString()], ['break-in', '2026-09-25T11:00:00.000Z']));
      expect((await getOpenShiftStart('u1'))?.toISOString()).toBe(START.toISOString());
    });
  });

  describe('getActiveDevice', () => {
    it('returns the stored device for the current shift', async () => {
      expect(await getActiveDevice('u1')).toBe('desktop');
      mockStateFindById.mockImplementation(() => lean({ activeDevice: 'mobile', shiftStartedAt: START }));
      expect(await getActiveDevice('u1')).toBe('mobile');
    });

    it('ignores a state that belongs to another shift', async () => {
      mockStateFindById.mockImplementation(() => lean({ activeDevice: 'mobile', shiftStartedAt: new Date('2026-09-24T10:00:00.000Z') }));
      expect(await getActiveDevice('u1')).toBeNull();
    });

    it('returns null with no state, no open shift, or an unknown stored value', async () => {
      mockStateFindById.mockImplementation(() => lean(null));
      expect(await getActiveDevice('u1')).toBeNull();
      mockStateFindById.mockImplementation(() => lean({ activeDevice: 'tablet', shiftStartedAt: START }));
      expect(await getActiveDevice('u1')).toBeNull();
      mockTimeLogFind.mockReturnValue(logs());
      expect(await getActiveDevice('u1')).toBeNull();
    });

    it('uses the start it is given and skips the shift lookup, and treats an explicit null as no shift', async () => {
      expect(await getActiveDevice('u1', START)).toBe('desktop');
      expect(mockTimeLogFind).not.toHaveBeenCalled();
      expect(await getActiveDevice('u1', null)).toBeNull();
      expect(mockStateFindById).toHaveBeenCalledTimes(1);
    });
  });

  describe('isDesktopActiveForUserId', () => {
    it('is true only for an enabled user whose active device is the computer', async () => {
      expect(await isDesktopActiveForUserId('u1')).toBe(true);
      mockStateFindById.mockImplementation(() => lean({ activeDevice: 'mobile', shiftStartedAt: START }));
      expect(await isDesktopActiveForUserId('u1')).toBe(false);
    });

    it('is false when the feature is off for the user and does not read shift state', async () => {
      mockCrmFindById.mockImplementation(() => lean({ deviceSwitchOverride: 'default' }));
      expect(await isDesktopActiveForUserId('u1')).toBe(false);
      expect(mockStateFindById).not.toHaveBeenCalled();
    });

    it('is false under the kill switch and when anything fails', async () => {
      process.env.MON_DEVICE_SWITCH_DISABLED = 'true';
      expect(await isDesktopActiveForUserId('u1')).toBe(false);
      delete process.env.MON_DEVICE_SWITCH_DISABLED;
      mockCrmFindById.mockImplementation(() => { throw new Error('db down'); });
      expect(await isDesktopActiveForUserId('u1')).toBe(false);
    });

    it('follows the environment list for a user left on default', async () => {
      mockCrmFindById.mockImplementation(() => lean({ deviceSwitchOverride: 'default' }));
      process.env.MON_DEVICE_SWITCH = 'u1';
      expect(await isDesktopActiveForUserId('u1')).toBe(true);
    });
  });

  describe('isMobileActiveWithFreshPhone', () => {
    beforeEach(() => {
      mockStateFindById.mockImplementation(() => lean({ activeDevice: 'mobile', shiftStartedAt: START }));
    });

    it('is true when the phone is the active device and pinged recently', async () => {
      expect(await isMobileActiveWithFreshPhone('u1', Date.now())).toBe(true);
      const filter = mockLocFindOne.mock.calls[0][0];
      expect(filter).toMatchObject({ userId: 'u1', deviceType: 'mobile' });
      expect(filter.lastSeenAt.$gte.getTime()).toBeLessThan(Date.now() - 19 * 60_000);
    });

    it('is false when the phone has been silent too long', async () => {
      mockLocFindOne.mockImplementation(() => lean(null));
      expect(await isMobileActiveWithFreshPhone('u1', Date.now())).toBe(false);
    });

    it('is false when the computer is the active device, without looking at the phone', async () => {
      mockStateFindById.mockImplementation(() => lean({ activeDevice: 'desktop', shiftStartedAt: START }));
      expect(await isMobileActiveWithFreshPhone('u1', Date.now())).toBe(false);
      expect(mockLocFindOne).not.toHaveBeenCalled();
    });

    it('is false when the feature is off or anything fails', async () => {
      mockCrmFindById.mockImplementation(() => lean({ deviceSwitchOverride: 'off' }));
      expect(await isMobileActiveWithFreshPhone('u1', Date.now())).toBe(false);
      mockCrmFindById.mockImplementation(() => { throw new Error('db down'); });
      expect(await isMobileActiveWithFreshPhone('u1', Date.now())).toBe(false);
    });
  });
});
