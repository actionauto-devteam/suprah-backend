const mockUserFindById = jest.fn();
const mockUserFindByIdAndUpdate = jest.fn();
const mockRequestUpdateMany = jest.fn();
const mockRequestFindOne = jest.fn();
const mockRequestCreate = jest.fn();
const mockRequestFindOneAndUpdate = jest.fn();
const mockReviewEventCreate = jest.fn();
const mockEmitDriverPoolChange = jest.fn();

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: jest.fn() },
}));
jest.mock('../../src/utils/socketEmitter', () => ({ emitDriverPoolChange: mockEmitDriverPoolChange }));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findById: mockUserFindById, findByIdAndUpdate: mockUserFindByIdAndUpdate },
}));
jest.mock('../../src/models/DriverRequest.model', () => ({
  __esModule: true,
  default: {
    updateMany: mockRequestUpdateMany,
    findOne: mockRequestFindOne,
    create: mockRequestCreate,
    findOneAndUpdate: mockRequestFindOneAndUpdate,
  },
}));
jest.mock('../../src/models/DriverReviewEvent.model', () => ({
  __esModule: true,
  default: { create: mockReviewEventCreate },
}));

import { approveDriverAccount } from '../../src/services/driverVerificationReview.service';
import { findOrCreatePendingDriverRequest } from '../../src/services/driverApplication.service';

const reviewer = { _id: 'admin-1', name: 'Super Admin', role: 'super_admin' };

// DriverRequest.findOne(...).sort(...) resolving to this request.
const latestRequestIs = (request: unknown) => mockRequestFindOne.mockReturnValue({ sort: () => Promise.resolve(request) });

describe('approveDriverAccount (super admin approves right away)', () => {
  let driver: any;

  beforeEach(() => {
    jest.clearAllMocks();
    driver = { _id: 'driver-1', role: 'driver', isApproved: false, onboardingCompleted: true, save: jest.fn().mockResolvedValue(undefined) };
    mockUserFindById.mockResolvedValue(driver);
    mockRequestUpdateMany.mockResolvedValue({ modifiedCount: 1 });
    mockReviewEventCreate.mockResolvedValue({});
  });

  it('approves the account and every pending application, without needing documents', async () => {
    latestRequestIs({ _id: 'req-1', status: 'approved' });
    const result = await approveDriverAccount({ driverId: 'driver-1', reviewer });

    expect(driver).toMatchObject({ role: 'driver', isApproved: true, onboardingCompleted: true });
    expect(driver.save).toHaveBeenCalled();
    expect(mockRequestUpdateMany).toHaveBeenCalledWith(
      { driverUserId: 'driver-1', status: 'pending' },
      { $set: expect.objectContaining({ status: 'approved', reviewedBy: 'admin-1' }) },
    );
    expect(mockRequestCreate).not.toHaveBeenCalled();
    expect(result.request).toEqual({ _id: 'req-1', status: 'approved' });
    expect(mockReviewEventCreate).toHaveBeenCalledWith(expect.objectContaining({ action: 'account_approved' }));
    // Open Dispatch screens refresh right away.
    expect(mockEmitDriverPoolChange).toHaveBeenCalledWith('driver-1');
  });

  it('creates the approved application the Driver Portal needs when there is none', async () => {
    latestRequestIs(null);
    mockRequestCreate.mockResolvedValue({ _id: 'req-new', status: 'approved' });
    const result = await approveDriverAccount({ driverId: 'driver-1', reviewer });
    expect(mockRequestCreate).toHaveBeenCalledWith(expect.objectContaining({ driverUserId: 'driver-1', status: 'approved' }));
    expect(result.request).toEqual({ _id: 'req-new', status: 'approved' });
  });

  it('undoes the account change if the application could not be updated', async () => {
    mockRequestUpdateMany.mockRejectedValue(new Error('database down'));
    mockUserFindByIdAndUpdate.mockReturnValue({ catch: () => Promise.resolve() });
    await expect(approveDriverAccount({ driverId: 'driver-1', reviewer })).rejects.toThrow('database down');
    expect(mockUserFindByIdAndUpdate).toHaveBeenCalledWith('driver-1', {
      $set: { role: 'driver', isApproved: false, onboardingCompleted: true },
    });
    expect(mockEmitDriverPoolChange).not.toHaveBeenCalled();
  });

  it("says so when the driver's account doesn't exist", async () => {
    mockUserFindById.mockResolvedValue(null);
    await expect(approveDriverAccount({ driverId: 'missing', reviewer })).rejects.toThrow(/couldn't find this driver's account/);
  });
});

describe('findOrCreatePendingDriverRequest (no duplicate applications)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates the pending application once, in one step', async () => {
    mockRequestFindOneAndUpdate.mockResolvedValue({ value: { _id: 'req-1' }, lastErrorObject: { updatedExisting: false } });
    await expect(findOrCreatePendingDriverRequest('driver-1')).resolves.toEqual({ request: { _id: 'req-1' }, created: true });
    expect(mockRequestFindOneAndUpdate).toHaveBeenCalledWith(
      { driverUserId: 'driver-1', status: 'pending' },
      { $setOnInsert: { driverUserId: 'driver-1', status: 'pending' } },
      expect.objectContaining({ upsert: true }),
    );
  });

  it('returns the existing pending application instead of making a second one', async () => {
    mockRequestFindOneAndUpdate.mockResolvedValue({ value: { _id: 'req-1' }, lastErrorObject: { updatedExisting: true } });
    await expect(findOrCreatePendingDriverRequest('driver-1')).resolves.toEqual({ request: { _id: 'req-1' }, created: false });
  });

  it('treats a duplicate from another device at the same instant as "already exists"', async () => {
    mockRequestFindOneAndUpdate.mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    mockRequestFindOne.mockResolvedValue({ _id: 'req-other-device' });
    await expect(findOrCreatePendingDriverRequest('driver-1')).resolves.toEqual({
      request: { _id: 'req-other-device' },
      created: false,
    });
  });

  it('passes on any other database error', async () => {
    mockRequestFindOneAndUpdate.mockRejectedValue(new Error('database down'));
    await expect(findOrCreatePendingDriverRequest('driver-1')).rejects.toThrow('database down');
  });
});
