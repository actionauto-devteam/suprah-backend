/**
 * A load moves its Inventory cars to In Transit at pickup. At delivery a car
 * coming to the dealership goes back to Ready for Sale, and a car on a load
 * made from a quote has reached its buyer, so it becomes Sold.
 */
import { inventoryStatusAtDelivery, inventoryVehicleIdsFollowingLoad } from '../../src/services/loadInventoryStatus';

const CAR_A = '64b0000000000000000000a1';
const CAR_B = '64b0000000000000000000a2';
const QUOTE = '64b0000000000000000000c1';

describe('inventoryStatusAtDelivery', () => {
  it('puts a car back on sale, or marks it Sold when the load took it to its buyer', () => {
    expect(inventoryStatusAtDelivery({})).toBe('Ready for Sale');
    expect(inventoryStatusAtDelivery({ quoteId: null })).toBe('Ready for Sale');
    expect(inventoryStatusAtDelivery(null)).toBe('Ready for Sale');
    expect(inventoryStatusAtDelivery({ quoteId: QUOTE })).toBe('Sold');
  });
});

describe('inventoryVehicleIdsFollowingLoad', () => {
  it("follows each stock car on a load that isn't from a quote, once, both ways", () => {
    const load = { vehicles: [{ vehicleId: CAR_A }, { vehicleId: CAR_B }, { vehicleId: CAR_A }, {}] };
    expect(inventoryVehicleIdsFollowingLoad(load, 'In Transit')).toEqual([CAR_A, CAR_B]);
    expect(inventoryVehicleIdsFollowingLoad(load, 'Ready for Sale')).toEqual([CAR_A, CAR_B]);
    expect(inventoryVehicleIdsFollowingLoad(load, 'Sold')).toEqual([]);
  });

  it('takes a customer shipment off sale at pickup and marks it Sold at delivery, never back on sale', () => {
    const load = { quoteId: QUOTE, vehicles: [{ vehicleId: CAR_A }] };
    expect(inventoryVehicleIdsFollowingLoad(load, 'In Transit')).toEqual([CAR_A]);
    expect(inventoryVehicleIdsFollowingLoad(load, 'Sold')).toEqual([CAR_A]);
    expect(inventoryVehicleIdsFollowingLoad(load, 'Ready for Sale')).toEqual([]);
  });

  it('ignores missing loads, vehicles and ids that are not valid', () => {
    expect(inventoryVehicleIdsFollowingLoad(null, 'In Transit')).toEqual([]);
    expect(inventoryVehicleIdsFollowingLoad({ vehicles: null }, 'In Transit')).toEqual([]);
    expect(inventoryVehicleIdsFollowingLoad({ vehicles: [{ vehicleId: 'not-an-id' }, null] }, 'Ready for Sale')).toEqual([]);
  });
});
