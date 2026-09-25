const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockResolveMode = jest.fn();
const mockEmitToOrg = jest.fn();

jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/EmployeeLocation.model', () => ({
  __esModule: true,
  default: { findOne: mockFindOne, findOneAndUpdate: mockFindOneAndUpdate },
}));
jest.mock('../../src/models/Place.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/PlaceVisit.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/PresenceEvent.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/LocationHistory.model', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../src/models/DrivingSession.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/SosAlert.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToOrg: mockEmitToOrg }));
jest.mock('../../src/utils/geofence', () => ({ distanceMeters: jest.fn(() => 0) }));
jest.mock('../../src/config/departmentMonitoring', () => ({
  isMobileMonitoringDept: jest.fn().mockResolvedValue(false),
  isLocationRequiredForUser: jest.fn().mockResolvedValue(true),
  resolveMonitoringMode: mockResolveMode,
}));
jest.mock('../../src/utils/companyTimezone', () => ({ getCompanyDayRange: jest.fn() }));
jest.mock('../../src/constants/departments', () => ({ isMandatoryLocationDept: jest.fn().mockResolvedValue(false) }));
jest.mock('../../src/utils/shiftStatus', () => ({ getShiftStatusForActor: jest.fn() }));
jest.mock('../../src/services/shiftAlerts.service', () => ({ fireShiftAlert: jest.fn() }));
jest.mock('../../src/services/notification.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/cache.util', () => ({ invalidateUserCache: jest.fn() }));

import locatorController from '../../src/controllers/locator.controller';

const originalFlag = process.env.LOC_STICKY_MOBILE;
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);

const phoneRecord = (overrides: Record<string, unknown> = {}) => ({
  userId: 'user-1',
  deviceType: 'mobile',
  sharingState: 'sharing',
  lastSeenAt: secondsAgo(30),
  currentPlaceId: 'place-1',
  coords: { lat: 14.5, lng: 121.0 },
  ...overrides,
});

const buildRequest = (deviceType: string | null = 'desktop', overrides: Record<string, unknown> = {}) => ({
  crmUser: {
    _id: 'user-1',
    fullName: 'Test Recon',
    organizationId: 'org-1',
    department: 'Recon',
    locationConsent: { granted: true },
    locationSharingOptOut: false,
    locationRequiredOverride: 'default',
    monitoringModeOverride: 'default',
    ...overrides,
  },
  orgId: 'org-1',
  body: { lat: 14.4, lng: 120.9, accuracyM: 5000, connectivity: 'online', ...(deviceType !== null && { deviceType }) },
});

const run = async (req: unknown) => {
  const json = jest.fn();
  const next = jest.fn();
  (locatorController.ingestLocation as any)(req, { json }, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, next, payload: json.mock.calls[0]?.[0]?.data };
};

describe('POST /api/locator/ping sticky mobile guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOC_STICKY_MOBILE = 'user-1';
    mockResolveMode.mockResolvedValue('switching');
    mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(phoneRecord()) });
    mockFindOneAndUpdate.mockResolvedValue({
      coords: { lat: 14.4, lng: 120.9 },
      sharingState: 'sharing',
      deviceType: 'desktop',
      lastSeenAt: new Date(),
    });
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.LOC_STICKY_MOBILE;
    else process.env.LOC_STICKY_MOBILE = originalFlag;
  });

  it('ignores a desktop ping while the phone is fresh and writes nothing', async () => {
    const { payload, next } = await run(buildRequest('desktop'));
    expect(next).not.toHaveBeenCalled();
    expect(payload).toEqual({ sharingState: 'sharing', currentPlaceId: 'place-1', ignored: true });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockEmitToOrg).not.toHaveBeenCalled();
  });

  it('passes the user monitoring-mode override to the resolver', async () => {
    await run(buildRequest('desktop', { monitoringModeOverride: 'switching' }));
    expect(mockResolveMode).toHaveBeenCalledWith('org-1', 'Recon', 'switching');
  });

  it('records the ping exactly as before while the flag is off', async () => {
    delete process.env.LOC_STICKY_MOBILE;
    const { payload, next } = await run(buildRequest('desktop'));
    expect(next).not.toHaveBeenCalled();
    expect(payload).not.toHaveProperty('ignored');
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockResolveMode).not.toHaveBeenCalled();
  });

  it('records the ping for a user who is not in the pilot list', async () => {
    process.env.LOC_STICKY_MOBILE = 'someone-else';
    const { payload } = await run(buildRequest('desktop'));
    expect(payload).not.toHaveProperty('ignored');
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockResolveMode).not.toHaveBeenCalled();
  });

  it.each(['off', 'always'])('records the ping in %s mode', async (mode) => {
    mockResolveMode.mockResolvedValue(mode);
    const { payload } = await run(buildRequest('desktop'));
    expect(payload).not.toHaveProperty('ignored');
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('records the desktop ping once the phone has been quiet longer than the sticky window', async () => {
    mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(phoneRecord({ lastSeenAt: secondsAgo(4 * 60) })) });
    const { payload } = await run(buildRequest('desktop'));
    expect(payload).not.toHaveProperty('ignored');
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('always records a phone ping', async () => {
    const { payload } = await run(buildRequest('mobile'));
    expect(payload).not.toHaveProperty('ignored');
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockResolveMode).not.toHaveBeenCalled();
  });

  it('records a ping that carries no device type', async () => {
    const { payload } = await run(buildRequest(null));
    expect(payload).not.toHaveProperty('ignored');
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('does no extra work when the last device was already a computer', async () => {
    mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(phoneRecord({ deviceType: 'desktop' })) });
    const { payload } = await run(buildRequest('desktop'));
    expect(payload).not.toHaveProperty('ignored');
    expect(mockResolveMode).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('records the first ping when there is no previous record', async () => {
    mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const { payload } = await run(buildRequest('desktop'));
    expect(payload).not.toHaveProperty('ignored');
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('records the ping when the phone had paused sharing', async () => {
    mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(phoneRecord({ sharingState: 'paused_break' })) });
    const { payload } = await run(buildRequest('desktop'));
    expect(payload).not.toHaveProperty('ignored');
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('still enforces consent before anything else', async () => {
    const { json, next } = await run(buildRequest('desktop', { locationConsent: { granted: false } }));
    expect(json).not.toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 403 });
    expect(mockFindOne).not.toHaveBeenCalled();
  });
});
