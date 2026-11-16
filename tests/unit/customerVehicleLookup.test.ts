/**
 * A customer opening a car by its id (Compare, financing) only gets cars on
 * the marketplace; staff lookups are unchanged. The model is a stand-in; no
 * database is used.
 */
const mockFindOne = jest.fn();
let mockFound: (query: any) => unknown = () => null;
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: {
    findOne: (query: unknown) => {
      mockFindOne(query);
      const chain: any = { select: () => chain, populate: () => Promise.resolve(mockFound(query)) };
      return chain;
    },
  },
}));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), invalidateByPrefix: jest.fn() } }));

import vehicleController from '../../src/controllers/vehicle.controller';

const CAR = '64b0000000000000000000a1';

function lookUp(user: Record<string, unknown>) {
  return new Promise<{ status?: number; body?: any }>((resolve) => {
    const req: any = { params: { id: CAR }, user, orgId: 'org-1', query: {} };
    const res: any = { status() { return this; }, json(body: any) { resolve({ status: 200, body }); return this; } };
    (vehicleController as any).getVehicleById(req, res, (error: any) => resolve({ status: error?.statusCode }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFound = () => null;
});

it('limits a customer to cars that are for sale on the marketplace', async () => {
  expect((await lookUp({ _id: 'c1', role: 'customer' })).status).toBe(404);
  expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });
});

it("keeps staff lookups to their own dealership's cars, any status", async () => {
  await lookUp({ _id: 's1', role: 'admin' });
  expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, organizationId: 'org-1' });
});

it("lets staff open another dealership's for-sale car the way a customer does (2026-11-16)", async () => {
  await lookUp({ _id: 's1', role: 'employee' });
  expect(mockFindOne).toHaveBeenNthCalledWith(1, { _id: CAR, isDeleted: false, organizationId: 'org-1' });
  expect(mockFindOne).toHaveBeenNthCalledWith(2, { _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });

  // Found on the marketplace: shown without the other dealership's cost.
  mockFound = (query) => (query.status ? { _id: CAR, status: 'Ready for Sale', price: 20000, cost: 15000, notes: [] } : null);
  const { status, body } = await lookUp({ _id: 's1', role: 'employee' });
  expect(status).toBe(200);
  expect(body.data.price).toBe(20000);
  expect(body.data).not.toHaveProperty('cost');
  expect(body.data).not.toHaveProperty('notes');
});

it("treats employees as staff of their own dealership (2026-11-16)", async () => {
  await lookUp({ _id: 'e1', role: 'employee', organizationRole: 'member' });
  expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, organizationId: 'org-1' });
});

it('limits drivers and any other account to cars on the marketplace (2026-11-16)', async () => {
  await lookUp({ _id: 'd1', role: 'driver' });
  expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });
  mockFindOne.mockClear();
  await lookUp({ _id: 'x1', role: 'something-else' });
  expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });
});
