/**
 * A customer's waiting request closes when its car is sold or removed, and
 * the customer is told once. Models are stand-ins; no database is used.
 */
const mockQuoteFind = jest.fn();
const mockQuoteUpdateOne = jest.fn();
const mockVehicleFind = jest.fn();
const mockNotify = jest.fn();
const mockInvalidate = jest.fn();
const mockEmit = jest.fn();

const chain = (result: () => unknown) => {
  const self: any = { select: () => self, sort: () => self, limit: () => self, lean: () => Promise.resolve(result()) };
  return self;
};

jest.mock('node-cron', () => ({ schedule: jest.fn() }));
jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    find: (filter: unknown) => chain(() => mockQuoteFind(filter)),
    updateOne: (...args: unknown[]) => mockQuoteUpdateOne(...args),
  },
}));
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: { find: (filter: unknown) => chain(() => mockVehicleFind(filter)) },
}));
jest.mock('../../src/services/customerShipments.service', () => ({
  notifyQuoteCustomer: (...args: unknown[]) => mockNotify(...args),
}));
jest.mock('../../src/services/cache.service', () => ({
  __esModule: true,
  default: { invalidateByPrefix: (...args: unknown[]) => mockInvalidate(...args) },
}));
jest.mock('../../src/utils/socketEmitter', () => ({
  getSocketIO: () => ({ to: () => ({ emit: (...args: unknown[]) => mockEmit(...args) }) }),
}));

import { closeUnavailableCustomerRequests } from '../../src/schedulers/customerRequestAvailability.scheduler';
import { vehicleStateOf } from '../../src/services/vehicleAvailability';

beforeEach(() => {
  jest.clearAllMocks();
  mockQuoteUpdateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe('vehicleStateOf', () => {
  it('treats hidden, archived and missing cars as removed, Sold as sold, everything else as available', () => {
    expect(vehicleStateOf(null)).toBe('removed');
    expect(vehicleStateOf({ status: 'Ready for Sale', isDeleted: true })).toBe('removed');
    expect(vehicleStateOf({ status: 'Ready for Sale', isArchived: true })).toBe('removed');
    expect(vehicleStateOf({ status: 'Sold' })).toBe('sold');
    for (const status of ['Ready for Sale', 'In Recon', 'In Transit']) {
      expect(vehicleStateOf({ status })).toBe('available');
    }
  });
});

describe('closeUnavailableCustomerRequests', () => {
  it('closes requests whose car was sold or removed and tells each customer once', async () => {
    mockQuoteFind.mockReturnValue([
      { _id: 'q-sold', organizationId: 'org-1', vehicleId: 'v-sold' },
      { _id: 'q-gone', organizationId: 'org-1', vehicleId: 'v-gone' },
      { _id: 'q-recon', organizationId: 'org-2', vehicleId: 'v-recon' },
      { _id: 'q-ok', organizationId: 'org-2', vehicleId: 'v-ok' },
    ]);
    mockVehicleFind.mockReturnValue([
      { _id: 'v-sold', status: 'Sold' },
      { _id: 'v-recon', status: 'In Recon' },
      { _id: 'v-ok', status: 'Ready for Sale' },
    ]);

    expect(await closeUnavailableCustomerRequests()).toBe(2);
    expect(mockQuoteFind).toHaveBeenCalledWith({ source: 'customer_portal', status: 'pending', vehicleId: { $ne: null } });
    expect(mockQuoteUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockQuoteUpdateOne).toHaveBeenCalledWith(
      { _id: 'q-sold', source: 'customer_portal', status: 'pending' },
      { $set: expect.objectContaining({ status: 'rejected', closedReason: 'vehicle_unavailable' }) },
    );
    expect(mockNotify).toHaveBeenCalledWith('org-1', 'q-sold', 'unavailable');
    expect(mockNotify).toHaveBeenCalledWith('org-1', 'q-gone', 'unavailable');
    expect(mockInvalidate).toHaveBeenCalledWith('quotes:org-1');
    expect(mockInvalidate).not.toHaveBeenCalledWith('quotes:org-2');
  });

  it("doesn't notify when staff answered the request in the meantime", async () => {
    mockQuoteFind.mockReturnValue([{ _id: 'q1', organizationId: 'org-1', vehicleId: 'v1' }]);
    mockVehicleFind.mockReturnValue([{ _id: 'v1', status: 'Sold' }]);
    mockQuoteUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    expect(await closeUnavailableCustomerRequests()).toBe(0);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('does nothing when no request is waiting', async () => {
    mockQuoteFind.mockReturnValue([]);
    expect(await closeUnavailableCustomerRequests()).toBe(0);
    expect(mockVehicleFind).not.toHaveBeenCalled();
  });
});
