const mockLoadClaim = jest.fn();
const mockUserFind = jest.fn();
const mockProfileFind = jest.fn();
const mockLocationFind = jest.fn();
const mockNotify = jest.fn();
const mockOrgActive = jest.fn();
const mockEligibility = jest.fn();
const mockConflicts = jest.fn();
const mockRouteSignals = jest.fn();

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: mockNotify }));
jest.mock('../../src/utils/calculations', () => ({ getCoordinatesFromZip: jest.fn().mockResolvedValue(null) }));
jest.mock('../../src/services/activeOrganizations.service', () => ({ isOrganizationActive: mockOrgActive }));
jest.mock('../../src/services/driverStatusTransition.service', () => ({ getDriverWorkEligibility: mockEligibility }));
jest.mock('../../src/services/driverWorkCommitment.service', () => ({ findDriverCommitmentConflicts: mockConflicts }));
jest.mock('../../src/services/driverRouteMatching.service', () => ({
  evaluateDriverRouteCompatibility: mockRouteSignals,
  getDriverLocationForMatching: jest.fn(),
}));
jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: {
    findOneAndUpdate: mockLoadClaim,
    // Still on the board after the announcement, so no alert is withdrawn.
    findById: () => ({ select: () => ({ lean: () => Promise.resolve({ status: 'Posted', additionalInfo: { visibility: 'public' } }) }) }),
  },
}));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToUser: jest.fn() }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { find: mockUserFind } }));
jest.mock('../../src/models/DriverProfile.model', () => ({ __esModule: true, default: { find: mockProfileFind } }));
jest.mock('../../src/models/DriverLocation.model', () => ({ __esModule: true, default: { find: mockLocationFind } }));

import { evaluateDriverLoadCompatibility } from '../../src/services/driverLoadCompatibility.service';
import { announceNewBoardLoad, newLoadAlertText } from '../../src/services/newLoadAlert.service';

// Sunday Oct 25, 2026, stored the way date pickers store it (UTC midnight).
const load = {
  _id: 'load-1',
  loadNumber: 'LD-20261019-004',
  organizationId: 'org-1',
  status: 'Posted',
  pickupLocation: { city: 'Denver', state: 'CO', zip: '80202' },
  deliveryLocation: { city: 'Phoenix', state: 'AZ', zip: '85001' },
  vehicles: [{}, {}],
  trailerType: 'open_2car',
  dates: { firstAvailable: new Date('2026-10-25T00:00:00Z') },
  additionalInfo: { visibility: 'public' },
};

const unknownRoute = {
  serviceArea: { status: 'unknown', serviceRadiusMiles: null, distanceFromHomeBaseToPickupMiles: null, homeBaseLabel: null },
  preferredRoute: { status: 'unknown', originState: null, destinationState: null, matchedRoute: null, preferredRoutes: [] },
  proximity: { distanceToPickupMiles: null, source: null, lastSeenAt: null },
} as any;

const fitsProfile = { userId: 'fits', trailerType: 'open_2car', maxVehicleCapacity: 2, availableDays: ['sunday', 'monday'] };

describe('newLoadAlertText', () => {
  it('says the load fits when the trailer and the work day both match', () => {
    const alert = newLoadAlertText(load, evaluateDriverLoadCompatibility(fitsProfile, load, unknownRoute));
    expect(alert).toEqual({
      type: 'new_load_available',
      title: 'New Load You Can Request',
      message:
        'Load LD-20261019-004 was just posted: Denver, CO to Phoenix, AZ, 2 vehicles, pickup Sun, Oct 25. ' +
        'It fits your trailer, and the pickup is on one of your work days. Open it to see the details and request it.',
      reasons: [],
    });
  });

  it("doesn't claim a match it couldn't compare (no trailer type or work days on file)", () => {
    const oneCar = { ...load, vehicles: [{}] };
    const alert = newLoadAlertText(oneCar, evaluateDriverLoadCompatibility({ maxVehicleCapacity: 1 }, oneCar, unknownRoute));
    expect(alert.type).toBe('new_load_available');
    expect(alert.message).toBe(
      'Load LD-20261019-004 was just posted: Denver, CO to Phoenix, AZ, 1 vehicle, pickup Sun, Oct 25. Open it to see the details and request it.',
    );
  });

  it('names every mismatch in plain words when the driver should check first', () => {
    const compatibility = evaluateDriverLoadCompatibility(
      { trailerType: 'enclosed_2car', maxVehicleCapacity: 2, availableDays: ['monday', 'tuesday'] },
      load,
      {
        ...unknownRoute,
        serviceArea: { status: 'outside', serviceRadiusMiles: 250, distanceFromHomeBaseToPickupMiles: 339.6, homeBaseLabel: 'Ogden, UT' },
        preferredRoute: { ...unknownRoute.preferredRoute, status: 'not_preferred' },
      },
    );
    const alert = newLoadAlertText(load, compatibility);
    expect(alert.type).toBe('new_load_check_first');
    expect(alert.title).toBe('New Load: Check Before Requesting');
    expect(alert.reasons).toEqual(['off_schedule', 'trailer_mismatch', 'outside_service_area', 'not_preferred_route']);
    expect(alert.message).toBe(
      'Load LD-20261019-004 was just posted: Denver, CO to Phoenix, AZ, 2 vehicles, pickup Sun, Oct 25. ' +
        "You can request it, but check first: the pickup is on Sunday, which isn't one of your work days; " +
        'it asks for an Open 2-Car trailer, and yours is an Enclosed 2-Car; ' +
        'the pickup is 340 miles from your home base, outside your 250-mile area; ' +
        "it isn't one of your preferred routes. Open it to see the details.",
    );
  });

  it('uses the right article for trailer names', () => {
    const rgnLoad = { ...load, vehicles: [{}], trailerType: 'rgn' };
    const alert = newLoadAlertText(
      rgnLoad,
      evaluateDriverLoadCompatibility({ trailerType: 'flatbed', maxVehicleCapacity: 2 }, rgnLoad, unknownRoute),
    );
    expect(alert.message).toContain('it asks for an RGN trailer, and yours is a Flatbed');
  });
});

describe('announceNewBoardLoad', () => {
  const env = { ...process.env };
  const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });
  const selectLean = (value: unknown) => ({ select: () => lean(value) });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    delete process.env.ALLOW_PRODUCTION_DB;
    mockOrgActive.mockResolvedValue(true);
    mockEligibility.mockResolvedValue({ eligible: true });
    mockConflicts.mockResolvedValue([]);
    mockRouteSignals.mockResolvedValue(unknownRoute);
    mockNotify.mockResolvedValue({});
    mockLoadClaim.mockReturnValue(lean(load));
    mockUserFind.mockReturnValue(
      selectLean([{ _id: 'fits' }, { _id: 'off-day' }, { _id: 'small-trailer' }, { _id: 'on-leave' }, { _id: 'busy' }]),
    );
    mockProfileFind.mockReturnValue(
      lean([
        fitsProfile,
        { ...fitsProfile, userId: 'off-day', availableDays: ['monday'] },
        { ...fitsProfile, userId: 'small-trailer', maxVehicleCapacity: 1 },
        { ...fitsProfile, userId: 'on-leave' },
        { ...fitsProfile, userId: 'busy' },
      ]),
    );
    mockLocationFind.mockReturnValue(selectLean([]));
  });

  afterAll(() => {
    process.env = env;
  });

  it('tells only drivers who could request it, with the right kind of notice', async () => {
    mockEligibility.mockImplementation(async (driverId: string) => ({ eligible: driverId !== 'on-leave' }));
    mockConflicts.mockImplementation(async ({ driverId }: any) => (driverId === 'busy' ? [{ reason: 'active_trip' }] : []));

    await expect(announceNewBoardLoad('load-1')).resolves.toEqual({ fits: 1, checkFirst: 1, notEligible: 3 });

    const sent = mockNotify.mock.calls.map(([params]) => [params.userId, params.type]);
    expect(sent.sort()).toEqual([
      ['fits', 'new_load_available'],
      ['off-day', 'new_load_check_first'],
    ]);
    expect(mockNotify.mock.calls[0][0]).toMatchObject({
      organizationId: 'org-1',
      metadata: { loadId: 'load-1', loadNumber: 'LD-20261019-004', route: '/driver/available-loads/load-1', pushTag: 'new-board-loads' },
    });
  });

  it('claims the load only while it is a public, unassigned Posted load, without changing updatedAt', async () => {
    await announceNewBoardLoad('load-1');
    const [filter, update, options] = mockLoadClaim.mock.calls[0];
    expect(filter).toMatchObject({
      _id: 'load-1',
      status: 'Posted',
      'additionalInfo.visibility': { $ne: 'private' },
      boardAlertSentAt: { $exists: false },
    });
    expect(update.$set.boardAlertSentAt).toBeInstanceOf(Date);
    expect(options).toMatchObject({ timestamps: false });
  });

  it('sends nothing when the load was already announced or left the board', async () => {
    mockLoadClaim.mockReturnValue(lean(null));
    await expect(announceNewBoardLoad('load-1')).resolves.toEqual({ fits: 0, checkFirst: 0, notEligible: 0 });
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('skips drivers who already requested the load', async () => {
    mockLoadClaim.mockReturnValue(lean({ ...load, driverRequests: [{ driverId: 'fits' }] }));
    await announceNewBoardLoad('load-1');
    expect(mockNotify.mock.calls.map(([params]) => params.userId)).not.toContain('fits');
  });

  it('never messages drivers from a local server connected to the live database', async () => {
    process.env.NODE_ENV = 'development';
    process.env.ALLOW_PRODUCTION_DB = 'supra-ai-prod.example.mongodb.net';
    await announceNewBoardLoad('load-1');
    expect(mockLoadClaim).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('does nothing for an organization that is no longer active', async () => {
    mockOrgActive.mockResolvedValue(false);
    await announceNewBoardLoad('load-1');
    expect(mockUserFind).not.toHaveBeenCalled();
  });
});
