/**
 * Signed-out visitors and customers only reach cars on the marketplace: the
 * public car page, questions to the dealership and finance applications.
 * Staff keep working with their own cars in every status. The model is a
 * stand-in; no database is used.
 */
const mockFindOne = jest.fn();
const mockFindById = jest.fn();
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: {
    findOne: (query: unknown) => {
      mockFindOne(query);
      const chain: any = { select: () => Promise.resolve(null), populate: () => Promise.resolve(null) };
      return chain;
    },
    findById: (id: unknown) => Promise.resolve(mockFindById(id)),
  },
}));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), invalidateByPrefix: jest.fn() } }));

import vehicleController from '../../src/controllers/vehicle.controller';
import { resolveLeadContext } from '../../src/middleware/leadContext.middleware';
import { isOnMarketplace, VEHICLE_NOT_FOR_SALE } from '../../src/utils/marketplaceVehicle';

const CAR = '64b0000000000000000000a1';

function run(handler: any, req: any) {
  return new Promise<{ status?: number; message?: string; passed?: boolean }>((resolve) => {
    const res: any = { status() { return this; }, json() { resolve({ status: 200 }); return this; } };
    handler(req, res, (error: any) => resolve(error ? { status: error.statusCode, message: error.message } : { passed: true }));
  });
}

const car = (overrides: Record<string, unknown> = {}) => ({
  _id: CAR,
  organizationId: 'org-1',
  status: 'Ready for Sale',
  isArchived: false,
  isDeleted: false,
  ...overrides,
});

beforeEach(() => jest.clearAllMocks());

describe('the public car page', () => {
  it('only looks up cars on the marketplace', async () => {
    const result = await run((vehicleController as any).getPublicVehicleById, { params: { id: CAR } });
    expect(result.status).toBe(404);
    expect(mockFindOne).toHaveBeenCalledWith({ _id: CAR, isDeleted: false, status: 'Ready for Sale', isArchived: { $ne: true } });
  });
});

describe('questions and finance applications', () => {
  const ask = (user: Record<string, unknown>) =>
    run(resolveLeadContext, { body: { vehicleId: CAR }, user });

  it('lets a customer ask about a car that is for sale, routed to its dealership', async () => {
    mockFindById.mockReturnValue(car());
    const req: any = { body: { vehicleId: CAR }, user: { role: 'customer', organizationId: 'org-2' } };
    expect(await run(resolveLeadContext, req)).toEqual({ passed: true });
    expect(req.leadContext.organizationId).toBe('org-1');
  });

  it("refuses a customer's question about a car that isn't for sale", async () => {
    for (const notForSale of [car({ status: 'In Recon' }), car({ status: 'Sold' }), car({ isArchived: true })]) {
      mockFindById.mockReturnValue(notForSale);
      expect(await ask({ role: 'customer' })).toEqual({ status: 404, message: VEHICLE_NOT_FOR_SALE });
    }
  });

  it("still lets staff work with their own dealership's cars in any status", async () => {
    mockFindById.mockReturnValue(car({ status: 'In Recon' }));
    expect(await ask({ role: 'admin', organizationId: 'org-1' })).toEqual({ passed: true });
  });
});

describe('isOnMarketplace', () => {
  it('is true only for Ready for Sale cars that are not archived or deleted', () => {
    expect(isOnMarketplace(car())).toBe(true);
    expect(isOnMarketplace(car({ status: 'In Transit' }))).toBe(false);
    expect(isOnMarketplace(car({ isArchived: true }))).toBe(false);
    expect(isOnMarketplace(car({ isDeleted: true }))).toBe(false);
    expect(isOnMarketplace(null)).toBe(false);
  });
});
