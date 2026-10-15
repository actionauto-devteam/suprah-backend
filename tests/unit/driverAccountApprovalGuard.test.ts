const mockUserFindById = jest.fn();
const mockProfileFindOne = jest.fn();
const mockStatusRequestFind = jest.fn();

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/services/notification.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/socketEmitter', () => ({
  emitDriverPoolChange: jest.fn(),
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
}));
jest.mock('../../src/services/driverLocationAccess.service', () => ({
  GPS_TRACKING_LOAD_STATUSES: ['Accepted', 'Picked Up', 'In-Transit'],
  emitDriverLocationToResponsibleDispatchers: jest.fn(),
}));
jest.mock('../../src/models/Load.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/DriverLocation.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: mockUserFindById } }));
jest.mock('../../src/models/DriverProfile.model', () => ({ __esModule: true, default: { findOne: mockProfileFindOne } }));
jest.mock('../../src/models/DriverStatusChangeRequest.model', () => ({
  __esModule: true,
  default: { find: mockStatusRequestFind },
}));

import {
  assertDriverCanTakeNewWork,
  isDriverAccountApproved,
} from '../../src/services/driverStatusTransition.service';

// User.findById(...).select(...).lean() resolving to this account.
const accountIs = (account: unknown) =>
  mockUserFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(account) }) });

describe('only drivers with an approved account can be given or take work', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // An active driver with no open Work Availability request.
    mockProfileFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ operationalStatus: 'active' }) }) });
    mockStatusRequestFind.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([]) }) });
  });

  it('treats approved accounts, and older accounts without the flag, as approved', async () => {
    accountIs({ isApproved: true });
    await expect(isDriverAccountApproved('d1')).resolves.toBe(true);
    accountIs({});
    await expect(isDriverAccountApproved('d1')).resolves.toBe(true);
    accountIs({ isApproved: false });
    await expect(isDriverAccountApproved('d1')).resolves.toBe(false);
    accountIs(null);
    await expect(isDriverAccountApproved('d1')).resolves.toBe(false);
  });

  it("refuses to assign or reassign a driver whose application isn't approved", async () => {
    accountIs({ isApproved: false });
    for (const action of ['assign', 'reassign', 'approve'] as const) {
      await expect(assertDriverCanTakeNewWork('d1', 'org-1', action)).rejects.toThrow(
        /application hasn't been approved yet, so they can't be given loads/,
      );
    }
    // Stopped before any availability lookup.
    expect(mockProfileFindOne).not.toHaveBeenCalled();
  });

  it('tells the driver plainly when they try to accept or request a load', async () => {
    accountIs({ isApproved: false });
    for (const action of ['accept', 'request'] as const) {
      await expect(assertDriverCanTakeNewWork('d1', 'org-1', action)).rejects.toThrow(
        /Your driver account hasn't been approved yet.*support@suprahai\.com/,
      );
    }
  });

  it('lets an approved, active driver through as before', async () => {
    accountIs({ isApproved: true });
    await expect(assertDriverCanTakeNewWork('d1', 'org-1', 'assign')).resolves.toMatchObject({ eligible: true });
  });
});
