const mockFind = jest.fn();
const mockUpdateOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockTimeLogFindOne = jest.fn();
const mockTimeLogCreate = jest.fn();
const mockCrmFindById = jest.fn();
const mockUserFindById = jest.fn();
const mockShiftStatus = jest.fn();
const mockFireShiftAlert = jest.fn();
const mockPostBatched = jest.fn();
const mockIsMandatory = jest.fn();
const mockResolveMode = jest.fn();
const mockIsLocationRequired = jest.fn();

jest.mock('node-cron', () => ({ __esModule: true, default: { schedule: jest.fn() } }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn() } }));
jest.mock('../../src/models/EmployeeLocation.model', () => ({
  __esModule: true,
  default: { find: mockFind, updateOne: mockUpdateOne, findOneAndUpdate: mockFindOneAndUpdate },
}));
jest.mock('../../src/models/TimeLog.model', () => ({
  __esModule: true,
  default: { findOne: mockTimeLogFindOne, create: mockTimeLogCreate },
}));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findById: mockCrmFindById } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: mockUserFindById } }));
jest.mock('../../src/utils/shiftStatus', () => ({ getShiftStatusForActor: mockShiftStatus }));
jest.mock('../../src/services/shiftAlerts.service', () => ({
  fireShiftAlert: mockFireShiftAlert,
  postBatchedShiftAlertMessages: mockPostBatched,
}));
jest.mock('../../src/constants/departments', () => ({ isMandatoryLocationDept: mockIsMandatory }));
jest.mock('../../src/config/departmentMonitoring', () => ({
  resolveMonitoringMode: mockResolveMode,
  isLocationRequiredForUser: mockIsLocationRequired,
}));

import { runLotTechLocationEscalation } from '../../src/schedulers/lotTechLocationEscalation.scheduler';
import { runConnectionLossShiftAlertCheck } from '../../src/schedulers/connectionLossShiftAlert.scheduler';

const originalFlag = process.env.LOC_DESKTOP_EXCUSE;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

const buildLoc = (overrides: Record<string, unknown> = {}) => ({
  _id: 'loc1',
  userId: 'u1',
  userModel: 'CrmUser',
  organizationId: 'org1',
  department: 'Recon',
  userName: 'Test Recon',
  sharingState: 'sharing',
  deviceType: 'desktop',
  lastSeenAt: minutesAgo(10),
  desktopLastSeenAt: secondsAgo(30),
  desktopInputAgeSec: 5,
  locationIssueDetectedAt: null,
  locationWarningStage: 0,
  connectionLostNotifiedAt: null,
  ...overrides,
});

const userDoc = {
  department: 'Recon',
  monitoringModeOverride: 'default',
  fullName: 'Test Recon',
  organizationId: 'org1',
  locationConsent: { granted: true },
  locationRequiredOverride: 'default',
};

const chainLean = (value: unknown) => ({ lean: jest.fn().mockResolvedValue(value) });

const setLocations = (locs: unknown[]) => {
  mockFind.mockReturnValue(chainLean(locs));
};

describe('location escalation schedulers with the desktop excuse', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LOC_DESKTOP_EXCUSE;
    mockIsMandatory.mockResolvedValue(true);
    mockResolveMode.mockResolvedValue('switching');
    mockIsLocationRequired.mockResolvedValue(true);
    mockShiftStatus.mockResolvedValue({ isOnShift: true, isOnBreak: false });
    mockTimeLogFindOne.mockReturnValue({ sort: () => ({ select: () => chainLean({ timestamp: minutesAgo(180) }) }) });
    mockCrmFindById.mockReturnValue({ select: () => chainLean(userDoc) });
    mockUserFindById.mockReturnValue({ select: () => chainLean(userDoc) });
    mockFireShiftAlert.mockResolvedValue(undefined);
    mockPostBatched.mockResolvedValue(undefined);
    mockUpdateOne.mockResolvedValue({});
    mockFindOneAndUpdate.mockResolvedValue({});
    mockTimeLogCreate.mockResolvedValue({});
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.LOC_DESKTOP_EXCUSE;
    else process.env.LOC_DESKTOP_EXCUSE = originalFlag;
  });

  describe('lotTechLocationEscalation', () => {
    it('behaves exactly as before while the flag is off', async () => {
      setLocations([buildLoc()]);
      const result = await runLotTechLocationEscalation();
      expect(result.warned).toBe(1);
      expect(mockFireShiftAlert).toHaveBeenCalledWith(expect.objectContaining({ notifyTitle: '📡 Location Signal Lost' }));
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'loc1' }, expect.objectContaining({ locationWarningStage: 1 }));
    });

    it('still auto clocks out after fifteen minutes while the flag is off', async () => {
      setLocations([buildLoc({ locationIssueDetectedAt: minutesAgo(20), locationWarningStage: 2 })]);
      const result = await runLotTechLocationEscalation();
      expect(result.clockedOut).toBe(1);
      expect(mockTimeLogCreate).toHaveBeenCalledTimes(1);
    });

    it('sends nothing for an excused user with a hidden tab', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'u1';
      setLocations([buildLoc()]);
      const result = await runLotTechLocationEscalation();
      expect(result).toMatchObject({ warned: 0, clockedOut: 0 });
      expect(mockFireShiftAlert).not.toHaveBeenCalled();
      expect(mockTimeLogCreate).not.toHaveBeenCalled();
      expect(mockUpdateOne).not.toHaveBeenCalled();
    });

    it('clears a running episode instead of clocking the user out', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'u1';
      setLocations([buildLoc({ locationIssueDetectedAt: minutesAgo(20), locationWarningStage: 2 })]);
      const result = await runLotTechLocationEscalation();
      expect(result.clockedOut).toBe(0);
      expect(mockTimeLogCreate).not.toHaveBeenCalled();
      expect(mockFireShiftAlert).not.toHaveBeenCalled();
      expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'loc1' }, { locationIssueDetectedAt: null, locationWarningStage: 0 });
    });

    it('does not excuse a user outside the pilot list', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'someone-else';
      setLocations([buildLoc()]);
      const result = await runLotTechLocationEscalation();
      expect(result.warned).toBe(1);
      expect(mockFireShiftAlert).toHaveBeenCalledTimes(1);
    });

    it('still escalates when the tray channel is stale', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'all';
      setLocations([buildLoc({ desktopLastSeenAt: minutesAgo(10) })]);
      const result = await runLotTechLocationEscalation();
      expect(result.warned).toBe(1);
      expect(mockFireShiftAlert).toHaveBeenCalledTimes(1);
    });

    it('still escalates when there is no tray channel at all', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'all';
      setLocations([buildLoc({ desktopLastSeenAt: undefined, desktopInputAgeSec: undefined })]);
      const result = await runLotTechLocationEscalation();
      expect(result.warned).toBe(1);
    });

    it('never excuses phone-only always mode', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'all';
      mockResolveMode.mockResolvedValue('always');
      setLocations([buildLoc()]);
      const result = await runLotTechLocationEscalation();
      expect(result.warned).toBe(1);
      expect(mockFireShiftAlert).toHaveBeenCalledTimes(1);
    });

    it('never excuses a declined permission', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'all';
      setLocations([buildLoc({ sharingState: 'declined_permission' })]);
      await runLotTechLocationEscalation();
      expect(mockFireShiftAlert).toHaveBeenCalledTimes(1);
    });

    it('never excuses a user who never started sharing', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'all';
      setLocations([buildLoc({ sharingState: 'off_duty' })]);
      await runLotTechLocationEscalation();
      expect(mockFireShiftAlert).toHaveBeenCalledTimes(1);
    });

    it('fails closed when the excuse lookup throws', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'all';
      mockCrmFindById.mockImplementation(() => { throw new Error('db down'); });
      setLocations([buildLoc()]);
      const result = await runLotTechLocationEscalation();
      expect(result.warned).toBe(1);
      expect(mockFireShiftAlert).toHaveBeenCalledTimes(1);
    });

    describe('switching department that is not mandatory', () => {
      beforeEach(() => {
        mockIsMandatory.mockResolvedValue(false);
      });

      it('excuses a locked phone when the computer shows recent input', async () => {
        process.env.LOC_DESKTOP_EXCUSE = 'u1';
        setLocations([buildLoc({ deviceType: 'mobile', lastSeenAt: minutesAgo(4), desktopInputAgeSec: 5 })]);
        const result = await runLotTechLocationEscalation();
        expect(result.warned).toBe(0);
        expect(mockFireShiftAlert).not.toHaveBeenCalled();
      });

      it('still escalates a locked phone when the computer has had no input for hours', async () => {
        process.env.LOC_DESKTOP_EXCUSE = 'u1';
        setLocations([buildLoc({ deviceType: 'mobile', lastSeenAt: minutesAgo(4), desktopInputAgeSec: 7200 })]);
        const result = await runLotTechLocationEscalation();
        expect(result.warned).toBe(1);
        expect(mockFireShiftAlert).toHaveBeenCalledTimes(1);
      });

      it('escalates a locked phone with no tray data exactly as before', async () => {
        setLocations([buildLoc({ deviceType: 'mobile', lastSeenAt: minutesAgo(4), desktopLastSeenAt: undefined })]);
        const result = await runLotTechLocationEscalation();
        expect(result.warned).toBe(1);
      });
    });
  });

  describe('connectionLossShiftAlert', () => {
    beforeEach(() => {
      mockIsMandatory.mockResolvedValue(false);
    });

    it('claims and alerts exactly as before while the flag is off', async () => {
      setLocations([buildLoc({ lastSeenAt: minutesAgo(20) })]);
      const result = await runConnectionLossShiftAlertCheck();
      expect(result.notified).toBe(1);
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockFireShiftAlert).toHaveBeenCalledWith(expect.objectContaining({ notifyTitle: '📡 Connection Lost' }));
    });

    it('skips an excused user before the claim is taken', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'u1';
      setLocations([buildLoc({ lastSeenAt: minutesAgo(20) })]);
      const result = await runConnectionLossShiftAlertCheck();
      expect(result.notified).toBe(0);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockFireShiftAlert).not.toHaveBeenCalled();
    });

    it('still alerts later once the tray stops, because the claim was never burned', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'u1';
      setLocations([buildLoc({ lastSeenAt: minutesAgo(20) })]);
      await runConnectionLossShiftAlertCheck();
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();

      setLocations([buildLoc({ lastSeenAt: minutesAgo(30), desktopLastSeenAt: minutesAgo(15) })]);
      const result = await runConnectionLossShiftAlertCheck();
      expect(result.notified).toBe(1);
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockFireShiftAlert).toHaveBeenCalledTimes(1);
    });

    it('does not excuse a user who never started sharing', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'all';
      setLocations([buildLoc({ lastSeenAt: minutesAgo(20), sharingState: 'off_duty' })]);
      const result = await runConnectionLossShiftAlertCheck();
      expect(result.notified).toBe(1);
    });

    it('fails closed when the excuse lookup throws', async () => {
      process.env.LOC_DESKTOP_EXCUSE = 'all';
      mockResolveMode.mockRejectedValue(new Error('lookup failed'));
      setLocations([buildLoc({ lastSeenAt: minutesAgo(20) })]);
      const result = await runConnectionLossShiftAlertCheck();
      expect(result.notified).toBe(1);
    });
  });
});
