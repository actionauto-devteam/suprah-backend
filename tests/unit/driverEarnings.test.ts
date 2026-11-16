/**
 * The driver's Earnings page counts and unpaid loads, worked out on the server.
 */
const mockPayoutFind = jest.fn();
const mockLoadCount = jest.fn();
const mockLoadFind = jest.fn();
const mockFindChain = { select: jest.fn(), sort: jest.fn(), limit: jest.fn(), lean: jest.fn() };

jest.mock('../../src/models/DriverPayout.model', () => ({
  __esModule: true,
  default: { find: (filter: unknown) => { mockPayoutFind(filter); return { select: () => ({ lean: () => Promise.resolve([{ loadId: 'paid-1' }, { loadId: 'processing-2' }, {}]) }) }; } },
}));
jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: {
    countDocuments: (filter: unknown) => Promise.resolve(mockLoadCount(filter)),
    find: (filter: unknown) => { mockLoadFind(filter); return mockFindChain; },
  },
}));

import fs from 'fs';
import path from 'path';
import { EARNINGS_UNPAID_LIMIT, driverEarningsSummary } from '../../src/services/driverEarnings.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockFindChain.select.mockReturnValue(mockFindChain);
  mockFindChain.sort.mockReturnValue(mockFindChain);
  mockFindChain.limit.mockReturnValue(mockFindChain);
  mockFindChain.lean.mockResolvedValue([{ _id: 'unpaid-3', loadNumber: 'LD-3' }]);
  mockLoadCount.mockImplementation((filter: any) => (filter._id ? 7 : 250));
});

describe('driverEarningsSummary', () => {
  it('counts every completed load and the ones still waiting for pay', async () => {
    const summary = await driverEarningsSummary('driver-1');
    expect(summary).toEqual({ completedCount: 250, unpaidCount: 7, unpaidLoads: [{ _id: 'unpaid-3', loadNumber: 'LD-3' }] });
    expect(mockPayoutFind).toHaveBeenCalledWith({ driverId: 'driver-1', status: { $in: ['paid', 'processing'] } });
    expect(mockLoadCount).toHaveBeenCalledWith({ assignedDriverId: 'driver-1', status: 'Delivered' });
    expect(mockLoadFind).toHaveBeenCalledWith({ assignedDriverId: 'driver-1', status: 'Delivered', _id: { $nin: ['paid-1', 'processing-2'] } });
  });

  it('lists only the newest unpaid loads, newest first', async () => {
    await driverEarningsSummary('driver-1');
    expect(mockFindChain.sort).toHaveBeenCalledWith({ deliveredAt: -1, createdAt: -1 });
    expect(mockFindChain.limit).toHaveBeenCalledWith(EARNINGS_UNPAID_LIMIT);
    expect(EARNINGS_UNPAID_LIMIT).toBe(100);
  });

  it('is the Earnings view of my-loads', () => {
    const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/driverTracking.controller.ts'), 'utf8');
    expect(controller).toContain('if (view === "earnings") {');
    expect(controller).toContain('await driverEarningsSummary(user._id)');
  });
});
