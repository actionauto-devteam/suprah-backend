const mockUpdateMany = jest.fn();
const mockFind = jest.fn();
const mockBulkWrite = jest.fn();

jest.mock('node-cron', () => ({ __esModule: true, default: { schedule: jest.fn() } }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/models/DriverProfile.model', () => {
  const actual = jest.requireActual('../../src/models/DriverProfile.model');
  return {
    __esModule: true,
    ...actual,
    default: { updateMany: mockUpdateMany, find: mockFind, bulkWrite: mockBulkWrite },
  };
});

// DriverProfile.find(...).select(...).lean() resolving to these profiles.
const findReturns = (profiles: unknown[]) =>
  mockFind.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(profiles) }) });

import { runDriverComplianceExpirySweep } from '../../src/schedulers/driverComplianceExpiry.scheduler';

// The hourly sweep that keeps the stored isComplianceExpired flag current for
// driver lists, counts and assign warnings.
describe('runDriverComplianceExpirySweep', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const cutoff = new Date(now);
  const anyExpired = [
    { licenseExpirationDate: { $lt: cutoff } },
    { medicalCardExpirationDate: { $lt: cutoff } },
    { insuranceExpirationDate: { $lt: cutoff } },
  ];

  beforeEach(() => {
    mockFind.mockReset();
    mockBulkWrite.mockReset().mockResolvedValue({});
    findReturns([]);
    mockUpdateMany.mockReset();
    mockUpdateMany
      .mockResolvedValueOnce({ modifiedCount: 3 })
      .mockResolvedValueOnce({ modifiedCount: 1 });
  });

  it('flags profiles with a date in the past that are not flagged yet', async () => {
    await runDriverComplianceExpirySweep(now);
    expect(mockUpdateMany).toHaveBeenNthCalledWith(
      1,
      { isComplianceExpired: { $ne: true }, $or: anyExpired },
      { $set: { isComplianceExpired: true } },
    );
  });

  it('clears the flag on renewed profiles (no date in the past any more)', async () => {
    await runDriverComplianceExpirySweep(now);
    expect(mockUpdateMany).toHaveBeenNthCalledWith(
      2,
      { isComplianceExpired: true, $nor: anyExpired },
      { $set: { isComplianceExpired: false } },
    );
  });

  it('reports how many profiles changed each way', async () => {
    await expect(runDriverComplianceExpirySweep(now)).resolves.toEqual({ renewed: 0, flagged: 3, cleared: 1 });
  });

  it('copies an approved renewal to the stored date before refreshing the flags', async () => {
    const renewed = new Date('2030-07-19T00:00:00Z');
    findReturns([
      {
        _id: 'profile-renewed',
        licenseExpirationDate: new Date('2026-10-07T00:00:00Z'),
        documents: [{ type: 'drivers_license', reviewStatus: 'approved', expiresAt: renewed }],
      },
      {
        _id: 'profile-current',
        licenseExpirationDate: renewed,
        documents: [{ type: 'drivers_license', reviewStatus: 'approved', expiresAt: renewed }],
      },
    ]);

    await expect(runDriverComplianceExpirySweep(now)).resolves.toEqual({ renewed: 1, flagged: 3, cleared: 1 });
    expect(mockBulkWrite).toHaveBeenCalledWith([
      { updateOne: { filter: { _id: 'profile-renewed' }, update: { $set: { licenseExpirationDate: renewed } } } },
    ]);
    expect(mockBulkWrite.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateMany.mock.invocationCallOrder[0]);
  });

  it('only looks at profiles with an approved credential document that has a date', async () => {
    await runDriverComplianceExpirySweep(now);
    expect(mockFind).toHaveBeenCalledWith({
      documents: {
        $elemMatch: {
          type: { $in: ['drivers_license', 'medical_card', 'insurance_certificate'] },
          reviewStatus: 'approved',
          expiresAt: { $ne: null },
        },
      },
    });
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });
});
