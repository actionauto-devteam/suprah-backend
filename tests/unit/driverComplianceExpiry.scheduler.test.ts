const mockUpdateMany = jest.fn();

jest.mock('node-cron', () => ({ __esModule: true, default: { schedule: jest.fn() } }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/models/DriverProfile.model', () => ({
  __esModule: true,
  default: { updateMany: mockUpdateMany },
  COMPLIANCE_EXPIRY_FIELDS: ['licenseExpirationDate', 'medicalCardExpirationDate', 'insuranceExpirationDate'],
}));

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
    await expect(runDriverComplianceExpirySweep(now)).resolves.toEqual({ flagged: 3, cleared: 1 });
  });
});
