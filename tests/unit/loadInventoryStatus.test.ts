/**
 * A load moves its Inventory cars to In Transit and Ready for Sale only when
 * it brings them to the dealership. A load made from a quote ships the car to
 * a customer and leaves its status alone.
 */
import { inventoryVehicleIdsFollowingLoad } from '../../src/services/loadInventoryStatus';

const CAR_A = '64b0000000000000000000a1';
const CAR_B = '64b0000000000000000000a2';

describe('inventoryVehicleIdsFollowingLoad', () => {
  it("follows each stock car on a load that isn't from a quote, once", () => {
    expect(
      inventoryVehicleIdsFollowingLoad({ vehicles: [{ vehicleId: CAR_A }, { vehicleId: CAR_B }, { vehicleId: CAR_A }, {}] }),
    ).toEqual([CAR_A, CAR_B]);
  });

  it('leaves the car alone on a load made from a quote', () => {
    expect(inventoryVehicleIdsFollowingLoad({ quoteId: '64b0000000000000000000c1', vehicles: [{ vehicleId: CAR_A }] })).toEqual([]);
  });

  it('ignores missing loads, vehicles and ids that are not valid', () => {
    expect(inventoryVehicleIdsFollowingLoad(null)).toEqual([]);
    expect(inventoryVehicleIdsFollowingLoad({ vehicles: null })).toEqual([]);
    expect(inventoryVehicleIdsFollowingLoad({ vehicles: [{ vehicleId: 'not-an-id' }, null] })).toEqual([]);
  });
});
