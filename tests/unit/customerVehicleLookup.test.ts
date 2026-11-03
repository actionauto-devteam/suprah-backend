/**
 * A customer opening a car by its id (Compare, financing) only gets cars on
 * the marketplace; staff lookups are unchanged. The model is a stand-in; no
 * database is used.
 */
const mockFindOne = jest.fn();
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: {
    findOne: (query: unknown) => {
      mockFindOne(query);
      const chain: any = { select: () => chain, populate: () => Promise.resolve(null) };
      return chain;
    },
  },
}));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), invalidateByPrefix: jest.fn() } }));

import vehicleController from '../../src/controllers/vehicle.controller';

const CAR = '64b0000000000000000000a1';

function lookUp(user: Record<string, unknown>) {
  return new Promise<{ status?: number }>((resolve) => {
    const req: any = { params: { id: CAR }, user, orgId: 'org-1', query: {} };
    const res: any = { status() { return this; }, json() { resolve({ status: 200 }); return this; } };
    (vehicleController as any).getVehicleById(req, res, (error: any) => resolve({ status: error?.statusCode }));
  });
}

beforeEach(() => jest.clearAllMocks());

it('limits a customer to cars that are for sale on the marketplace', async () => {
  expect((await lookUp({ _id: 'c1', role: 'customer' })).status).toBe(404);
  expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });
});

it("keeps staff lookups to their own dealership's cars, any status", async () => {
  await lookUp({ _id: 's1', role: 'admin' });
  expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, organizationId: 'org-1' });
});
