const mockUpdateOne = jest.fn();
const mockIsLocationRequired = jest.fn();
const mockResolveMode = jest.fn();
const mockShiftStatus = jest.fn();

jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/EmployeeLocation.model', () => ({ __esModule: true, default: { updateOne: mockUpdateOne } }));
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
  isLocationRequiredForUser: mockIsLocationRequired,
  resolveMonitoringMode: mockResolveMode,
}));
jest.mock('../../src/utils/companyTimezone', () => ({ getCompanyDayRange: jest.fn() }));
jest.mock('../../src/constants/departments', () => ({ isMandatoryLocationDept: jest.fn() }));
jest.mock('../../src/utils/shiftStatus', () => ({ getShiftStatusForActor: mockShiftStatus }));
jest.mock('../../src/services/shiftAlerts.service', () => ({ fireShiftAlert: jest.fn() }));
jest.mock('../../src/services/notification.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/cache.util', () => ({ invalidateUserCache: jest.fn() }));

import locatorController from '../../src/controllers/locator.controller';

const originalFlag = process.env.LOC_DESKTOP_CHANNEL;
const originalPlatforms = process.env.LOC_DESKTOP_PLATFORMS;

const buildRequest = (overrides: Record<string, unknown> = {}, body: unknown = { lat: 14.4, lng: 120.9, accuracyM: 180, inputAgeSec: 12, platform: 'win32' }) => ({
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
  body,
});

const run = async (req: unknown) => {
  const json = jest.fn();
  const next = jest.fn();
  (locatorController.ingestDesktopLocation as any)(req, { json }, next);
  await new Promise((resolve) => setImmediate(resolve));
  return { json, next, payload: json.mock.calls[0]?.[0]?.data };
};

describe('POST /api/locator/desktop-ping', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.LOC_DESKTOP_CHANNEL = 'user-1';
    delete process.env.LOC_DESKTOP_PLATFORMS;
    mockIsLocationRequired.mockResolvedValue(true);
    mockResolveMode.mockResolvedValue('switching');
    mockShiftStatus.mockResolvedValue({ isOnShift: true, isOnBreak: false });
    mockUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.LOC_DESKTOP_CHANNEL;
    else process.env.LOC_DESKTOP_CHANNEL = originalFlag;
    if (originalPlatforms === undefined) delete process.env.LOC_DESKTOP_PLATFORMS;
    else process.env.LOC_DESKTOP_PLATFORMS = originalPlatforms;
  });

  it('does nothing at all while the flag is off', async () => {
    delete process.env.LOC_DESKTOP_CHANNEL;
    const { payload, next } = await run(buildRequest());
    expect(payload).toEqual({ accepted: false, reason: 'flag_off', retryAfterSec: 300 });
    expect(next).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockIsLocationRequired).not.toHaveBeenCalled();
    expect(mockResolveMode).not.toHaveBeenCalled();
    expect(mockShiftStatus).not.toHaveBeenCalled();
  });

  it('does nothing for a user who is not in the pilot list', async () => {
    process.env.LOC_DESKTOP_CHANNEL = 'someone-else';
    const { payload } = await run(buildRequest());
    expect(payload).toMatchObject({ accepted: false, reason: 'flag_off' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('answers flag_off before validating the body', async () => {
    delete process.env.LOC_DESKTOP_CHANNEL;
    const { payload, next } = await run(buildRequest({}, { nonsense: true }));
    expect(payload).toMatchObject({ accepted: false, reason: 'flag_off' });
    expect(next).not.toHaveBeenCalled();
  });

  it('writes only the desktop fields, never the main record fields', async () => {
    const { payload, next } = await run(buildRequest());
    expect(next).not.toHaveBeenCalled();
    expect(payload).toEqual({ accepted: true });
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);

    const [filter, update, options] = mockUpdateOne.mock.calls[0];
    expect(filter).toEqual({ userId: 'user-1', sharingState: 'sharing' });
    expect(options).toEqual({ timestamps: false });
    expect(Object.keys(update)).toEqual(['$set']);
    expect(Object.keys(update.$set).sort()).toEqual([
      'desktopAccuracyM', 'desktopCoords', 'desktopInputAgeSec', 'desktopLastSeenAt', 'desktopPlatform',
    ]);
    expect(update.$set.desktopCoords).toEqual({ lat: 14.4, lng: 120.9 });
    expect(update.$set.desktopAccuracyM).toBe(180);
    expect(update.$set.desktopInputAgeSec).toBe(12);
    expect(update.$set.desktopPlatform).toBe('win32');
    expect(update.$set.desktopLastSeenAt).toBeInstanceOf(Date);
    for (const forbidden of ['coords', 'deviceType', 'lastSeenAt', 'sharingState', 'locationIssueDetectedAt', 'locationWarningStage', 'currentPlaceId']) {
      expect(update.$set).not.toHaveProperty(forbidden);
    }
    expect(update).not.toHaveProperty('$setOnInsert');
  });

  it('never upserts', async () => {
    await run(buildRequest());
    expect(mockUpdateOne.mock.calls[0][2]).not.toHaveProperty('upsert');
  });

  it('reports no_active_record when there is no sharing record to attach to', async () => {
    mockUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const { payload } = await run(buildRequest());
    expect(payload).toEqual({ accepted: false, reason: 'no_active_record', retryAfterSec: 120 });
  });

  it('rejects a body without valid coordinates with a 400', async () => {
    const { next, json } = await run(buildRequest({}, { lat: 'x', lng: 1 }));
    expect(json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toMatchObject({ statusCode: 400 });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it.each([
    ['not on shift', { isOnShift: false, isOnBreak: false }, 'not_on_shift'],
    ['on break', { isOnShift: true, isOnBreak: true }, 'on_break'],
  ])('rejects while %s', async (_label, shift, reason) => {
    mockShiftStatus.mockResolvedValue(shift);
    const { payload } = await run(buildRequest());
    expect(payload).toMatchObject({ accepted: false, reason });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('rejects without consent and when the user opted out', async () => {
    const noConsent = await run(buildRequest({ locationConsent: { granted: false } }));
    expect(noConsent.payload).toMatchObject({ accepted: false, reason: 'no_consent' });
    const optedOut = await run(buildRequest({ locationSharingOptOut: true }));
    expect(optedOut.payload).toMatchObject({ accepted: false, reason: 'opted_out' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('rejects when location is not required or the department is phone-only', async () => {
    mockIsLocationRequired.mockResolvedValue(false);
    const notRequired = await run(buildRequest());
    expect(notRequired.payload).toMatchObject({ accepted: false, reason: 'not_required' });

    mockIsLocationRequired.mockResolvedValue(true);
    mockResolveMode.mockResolvedValue('always');
    const phoneOnly = await run(buildRequest());
    expect(phoneOnly.payload).toMatchObject({ accepted: false, reason: 'not_applicable' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('rejects a platform that is not allowed and honors the platform override', async () => {
    const linux = await run(buildRequest({}, { lat: 1, lng: 2, platform: 'linux' }));
    expect(linux.payload).toMatchObject({ accepted: false, reason: 'platform_not_allowed' });

    process.env.LOC_DESKTOP_PLATFORMS = 'win32';
    const mac = await run(buildRequest({}, { lat: 1, lng: 2, platform: 'darwin' }));
    expect(mac.payload).toMatchObject({ accepted: false, reason: 'platform_not_allowed' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('passes the user monitoring-mode override through to the mode resolver', async () => {
    await run(buildRequest({ monitoringModeOverride: 'off' }));
    expect(mockResolveMode).toHaveBeenCalledWith('org-1', 'Recon', 'off');
  });
});
