/**
 * Which cars a dealership is already shipping: live loads (not delivered or
 * cancelled) and waiting quotes for the same inventory car or VIN, only in
 * the dealership's own records. Models are stand-ins; no database is used.
 */
const mockLoadFind = jest.fn();
const mockQuoteFind = jest.fn();

const chain = (result: () => unknown) => {
  const self: any = { select: () => self, sort: () => self, limit: () => self, lean: () => Promise.resolve(result()) };
  return self;
};

jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: { find: (filter: unknown) => chain(() => mockLoadFind(filter)) },
}));
jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: { find: (filter: unknown) => chain(() => mockQuoteFind(filter)) },
}));

import {
  VEHICLE_SHIPPING_LOOKUP_MAX,
  cleanVehicleShippingQuery,
  findVehicleShipping,
} from '../../src/services/vehicleShipping.service';

const ORG = '64b0000000000000000000a1';
const CAR = '64b0000000000000000000b1';
const LOAD = '64b0000000000000000000c1';
const VIN = '1HGCM82633A123456';

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadFind.mockReturnValue([]);
  mockQuoteFind.mockReturnValue([]);
});

describe('cleanVehicleShippingQuery', () => {
  it('keeps valid ids and VINs once, from a list or a comma-separated string', () => {
    expect(cleanVehicleShippingQuery({ vehicleIds: `${CAR}, ${CAR},not-an-id`, vins: ['1hgcm8-2633a 123456', VIN, '', 42] })).toEqual({
      vehicleIds: [CAR],
      vins: [VIN],
    });
    expect(cleanVehicleShippingQuery({ vehicleIds: { $ne: null }, vins: { $gt: '' } })).toEqual({ vehicleIds: [], vins: [] });
  });

  it('caps how many cars one lookup checks', () => {
    const vins = Array.from({ length: VEHICLE_SHIPPING_LOOKUP_MAX + 20 }, (_, i) => `VIN${i}`);
    expect(cleanVehicleShippingQuery({ vins }).vins).toHaveLength(VEHICLE_SHIPPING_LOOKUP_MAX);
  });
});

describe('findVehicleShipping', () => {
  it("looks only at the dealership's live loads for the car, by inventory id or VIN", async () => {
    mockLoadFind.mockReturnValue([
      { _id: LOAD, loadNumber: 'LD-7', status: 'Posted', vehicles: [{ vehicleId: CAR, vin: VIN.toLowerCase() }, { make: 'Ford' }] },
    ]);
    const result = await findVehicleShipping(ORG, { vehicleIds: [CAR], vins: [VIN] });
    expect(result.loads).toEqual([{ _id: LOAD, loadNumber: 'LD-7', status: 'Posted', vehicleIds: [CAR], vins: [VIN] }]);
    expect(result.quotes).toEqual([]);
    expect(mockQuoteFind).not.toHaveBeenCalled();

    const filter = mockLoadFind.mock.calls[0][0];
    expect(filter.organizationId).toBe(ORG);
    expect(filter.status).toEqual({ $nin: ['Delivered', 'Cancelled'] });
    expect(String(filter.$or[0]['vehicles.vehicleId'].$in[0])).toBe(CAR);
    expect(filter.$or[1]).toEqual({ 'vehicles.vin': { $in: [VIN] } });
    expect(filter).not.toHaveProperty('_id');
  });

  it('leaves out the load being edited or just created', async () => {
    await findVehicleShipping(ORG, { vins: [VIN] }, { excludeLoadId: LOAD });
    expect(mockLoadFind.mock.calls[0][0]._id).toEqual({ $ne: LOAD });
  });

  it('adds waiting quotes when asked', async () => {
    mockQuoteFind.mockReturnValue([{ _id: 'quote-1', status: 'pending', vehicleId: CAR }]);
    const result = await findVehicleShipping(ORG, { vehicleIds: [CAR] }, { includeQuotes: true });
    expect(result.quotes).toEqual([{ _id: 'quote-1', status: 'pending', vehicleId: CAR }]);
    const filter = mockQuoteFind.mock.calls[0][0];
    expect(filter.organizationId).toBe(ORG);
    expect(filter.status).toEqual({ $in: ['pending', 'accepted'] });
  });

  it('asks nothing without a car or a dealership', async () => {
    expect(await findVehicleShipping(ORG, { vehicleIds: ['bad'], vins: [''] }, { includeQuotes: true })).toEqual({ loads: [], quotes: [] });
    expect(await findVehicleShipping('', { vins: [VIN] })).toEqual({ loads: [], quotes: [] });
    expect(mockLoadFind).not.toHaveBeenCalled();
    expect(mockQuoteFind).not.toHaveBeenCalled();
  });
});
