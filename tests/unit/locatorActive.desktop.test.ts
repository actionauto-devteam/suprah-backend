const mockFind = jest.fn();
const mockUpdateMany = jest.fn();
const mockUpdateOne = jest.fn();
const mockCrmFindById = jest.fn();
const mockUserFindById = jest.fn();
const mockResolveMode = jest.fn();

jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: mockUserFindById } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findById: mockCrmFindById } }));
jest.mock('../../src/models/EmployeeLocation.model', () => ({
  __esModule: true,
  default: { find: mockFind, updateMany: mockUpdateMany, updateOne: mockUpdateOne },
}));
jest.mock('../../src/models/Place.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/PlaceVisit.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/PresenceEvent.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/LocationHistory.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/DrivingSession.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/SosAlert.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn() }));
jest.mock('../../src/utils/geofence', () => ({ distanceMeters: jest.fn() }));
jest.mock('../../src/config/departmentMonitoring', () => ({
  isMobileMonitoringDept: jest.fn(),
  isLocationRequiredForUser: jest.fn(),
  resolveMonitoringMode: mockResolveMode,
}));
jest.mock('../../src/utils/companyTimezone', () => ({ getCompanyDayRange: jest.fn() }));
jest.mock('../../src/constants/departments', () => ({ isMandatoryLocationDept: jest.fn() }));
jest.mock('../../src/utils/shiftStatus', () => ({ getShiftStatusForActor: jest.fn() }));
jest.mock('../../src/services/shiftAlerts.service', () => ({ fireShiftAlert: jest.fn() }));
jest.mock('../../src/services/notification.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/cache.util', () => ({ invalidateUserCache: jest.fn() }));

import locatorController from '../../src/controllers/locator.controller';

const originalExcuse = process.env.LOC_DESKTOP_EXCUSE;
const originalDisplay = process.env.LOC_DESKTOP_DISPLAY;
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

const buildRow = (overrides: Record<string, unknown> = {}) => ({
  _id: 'loc1',
  userId: {
    _id: 'u1',
    email: 'recon@example.com',
    name: 'Test Recon',
    avatar: null,
    department: 'Recon',
    personalInfo: {},
    employmentLocationType: 'onsite',
  },
  userModel: 'CrmUser',
  organizationId: 'org1',
  userName: 'Test Recon',
  department: 'Recon',
  coords: { lat: 14.5, lng: 121.0 },
  accuracyM: 20,
  heading: 90,
  speedMph: 3,
  sharingState: 'sharing',
  deviceType: 'desktop',
  connectivity: 'online',
  lastSeenAt: minutesAgo(15),
  desktopLastSeenAt: secondsAgo(30),
  desktopCoords: { lat: 14.6, lng: 121.1 },
  desktopAccuracyM: 150,
  desktopInputAgeSec: 5,
  ...overrides,
});

const load = async (rows: unknown[]) => {
  mockFind.mockReturnValue({ populate: () => ({ lean: () => Promise.resolve(rows) }) });
  const json = jest.fn();
  const next = jest.fn();
  (locatorController.getActiveEmployeeLocations as any)({ orgId: 'org1' }, { json }, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { next, list: json.mock.calls[0]?.[0]?.data as any[] };
};

describe('GET /api/locator/active with the desktop channel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LOC_DESKTOP_EXCUSE;
    delete process.env.LOC_DESKTOP_DISPLAY;
    mockResolveMode.mockResolvedValue('switching');
    mockCrmFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ department: 'Recon', monitoringModeOverride: 'default' }) }) });
    mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ personalInfo: { department: 'Recon' } }) }) });
    mockUpdateMany.mockResolvedValue({});
    mockUpdateOne.mockResolvedValue({});
  });

  afterAll(() => {
    if (originalExcuse === undefined) delete process.env.LOC_DESKTOP_EXCUSE;
    else process.env.LOC_DESKTOP_EXCUSE = originalExcuse;
    if (originalDisplay === undefined) delete process.env.LOC_DESKTOP_DISPLAY;
    else process.env.LOC_DESKTOP_DISPLAY = originalDisplay;
  });

  it('demotes a quiet sharing record exactly as before while the flags are off', async () => {
    const { list, next } = await load([buildRow()]);
    expect(next).not.toHaveBeenCalled();
    expect(list[0].sharingState).toBe('off_duty');
    expect(list[0].coords).toEqual({ lat: 14.5, lng: 121.0 });
    expect(list[0]).not.toHaveProperty('locationSource');
    expect(mockUpdateMany).toHaveBeenCalledWith({ _id: { $in: ['loc1'] } }, { sharingState: 'off_duty' });
    expect(mockCrmFindById).not.toHaveBeenCalled();
  });

  it('does not touch a record that is still fresh', async () => {
    const { list } = await load([buildRow({ lastSeenAt: secondsAgo(60) })]);
    expect(list[0].sharingState).toBe('sharing');
    expect(mockUpdateMany).not.toHaveBeenCalled();
    expect(mockCrmFindById).not.toHaveBeenCalled();
  });

  it('does not demote a user whose computer channel is alive when the excuse flag is on', async () => {
    process.env.LOC_DESKTOP_EXCUSE = 'u1';
    const { list } = await load([buildRow()]);
    expect(list[0].sharingState).toBe('sharing');
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('still demotes when the computer channel is stale', async () => {
    process.env.LOC_DESKTOP_EXCUSE = 'u1';
    const { list } = await load([buildRow({ desktopLastSeenAt: minutesAgo(10) })]);
    expect(list[0].sharingState).toBe('off_duty');
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('still demotes a locked phone when the computer shows no recent input', async () => {
    process.env.LOC_DESKTOP_EXCUSE = 'u1';
    const { list } = await load([buildRow({ deviceType: 'mobile', lastSeenAt: minutesAgo(15), desktopInputAgeSec: 7200 })]);
    expect(list[0].sharingState).toBe('off_duty');
  });

  it('fails closed and demotes when the excuse lookup throws', async () => {
    process.env.LOC_DESKTOP_EXCUSE = 'u1';
    mockCrmFindById.mockImplementation(() => { throw new Error('db down'); });
    const { list, next } = await load([buildRow()]);
    expect(next).not.toHaveBeenCalled();
    expect(list[0].sharingState).toBe('off_duty');
  });

  it('shows the tray location with a label when the display flag is on', async () => {
    process.env.LOC_DESKTOP_EXCUSE = 'u1';
    process.env.LOC_DESKTOP_DISPLAY = 'u1';
    const row = buildRow();
    const { list } = await load([row]);
    expect(list[0]).toMatchObject({
      coords: { lat: 14.6, lng: 121.1 },
      accuracyM: 150,
      deviceType: 'desktop',
      lastSeenAt: row.desktopLastSeenAt,
      locationSource: 'tray',
      sharingState: 'sharing',
    });
    expect(list[0].heading).toBeUndefined();
    expect(list[0].speedMph).toBeUndefined();
  });

  it('never exposes the computer input age to the admin view', async () => {
    process.env.LOC_DESKTOP_EXCUSE = 'u1';
    process.env.LOC_DESKTOP_DISPLAY = 'u1';
    const { list } = await load([buildRow()]);
    expect(JSON.stringify(list[0])).not.toContain('desktopInputAgeSec');
    expect(list[0]).not.toHaveProperty('desktopInputAgeSec');
    expect(list[0]).not.toHaveProperty('desktopCoords');
  });

  it('keeps the main location when the display flag is off', async () => {
    process.env.LOC_DESKTOP_EXCUSE = 'u1';
    const { list } = await load([buildRow()]);
    expect(list[0].coords).toEqual({ lat: 14.5, lng: 121.0 });
    expect(list[0]).not.toHaveProperty('locationSource');
  });

  it('keeps the main location for a user outside the display pilot list', async () => {
    process.env.LOC_DESKTOP_EXCUSE = 'all';
    process.env.LOC_DESKTOP_DISPLAY = 'someone-else';
    const { list } = await load([buildRow()]);
    expect(list[0].coords).toEqual({ lat: 14.5, lng: 121.0 });
  });

  it('keeps the phone location while the phone is fresh', async () => {
    process.env.LOC_DESKTOP_DISPLAY = 'u1';
    const { list } = await load([buildRow({ deviceType: 'mobile', lastSeenAt: secondsAgo(40) })]);
    expect(list[0].coords).toEqual({ lat: 14.5, lng: 121.0 });
    expect(list[0].deviceType).toBe('mobile');
    expect(list[0]).not.toHaveProperty('locationSource');
  });

  it('keeps the main location for a record that has no computer coordinates', async () => {
    process.env.LOC_DESKTOP_DISPLAY = 'u1';
    const { list } = await load([buildRow({ desktopCoords: undefined, lastSeenAt: secondsAgo(60) })]);
    expect(list[0].coords).toEqual({ lat: 14.5, lng: 121.0 });
  });

  it('keeps the main location when the display flag is on but the record was demoted', async () => {
    process.env.LOC_DESKTOP_DISPLAY = 'u1';
    const { list } = await load([buildRow()]);
    expect(list[0].sharingState).toBe('off_duty');
    expect(list[0].coords).toEqual({ lat: 14.5, lng: 121.0 });
    expect(list[0]).not.toHaveProperty('locationSource');
  });
});
