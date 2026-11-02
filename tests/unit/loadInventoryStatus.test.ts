/**
 * A load moves its Inventory cars to In Transit at pickup and Ready for Sale
 * at delivery when it brings them to the dealership. A load made from a quote
 * ships the car to a customer: it still goes In Transit at pickup (off the
 * marketplace) but is never put back on sale at delivery.
 */
import { inventoryVehicleIdsFollowingLoad } from '../../src/services/loadInventoryStatus';

const CAR_A = '64b0000000000000000000a1';
const CAR_B = '64b0000000000000000000a2';
const QUOTE = '64b0000000000000000000c1';

describe('inventoryVehicleIdsFollowingLoad', () => {
  it("follows each stock car on a load that isn't from a quote, once, both ways", () => {
    const load = { vehicles: [{ vehicleId: CAR_A }, { vehicleId: CAR_B }, { vehicleId: CAR_A }, {}] };
    expect(inventoryVehicleIdsFollowingLoad(load, 'In Transit')).toEqual([CAR_A, CAR_B]);
    expect(inventoryVehicleIdsFollowingLoad(load, 'Ready for Sale')).toEqual([CAR_A, CAR_B]);
  });

  it('takes a customer shipment off sale at pickup but never puts it back on sale at delivery', () => {
    const load = { quoteId: QUOTE, vehicles: [{ vehicleId: CAR_A }] };
    expect(inventoryVehicleIdsFollowingLoad(load, 'In Transit')).toEqual([CAR_A]);
    expect(inventoryVehicleIdsFollowingLoad(load, 'Ready for Sale')).toEqual([]);
  });

  it('ignores missing loads, vehicles and ids that are not valid', () => {
    expect(inventoryVehicleIdsFollowingLoad(null, 'In Transit')).toEqual([]);
    expect(inventoryVehicleIdsFollowingLoad({ vehicles: null }, 'In Transit')).toEqual([]);
    expect(inventoryVehicleIdsFollowingLoad({ vehicles: [{ vehicleId: 'not-an-id' }, null] }, 'Ready for Sale')).toEqual([]);
  });
});
