/**
 * A staff quote can only be linked to a car in the staff member's own dealership.
 */
import { QUOTE_VEHICLE_NOT_IN_INVENTORY, ownDealershipVehicleFilter } from '../../src/utils/quoteVehicle';
import fs from 'fs';
import path from 'path';

const CAR = '64b0000000000000000000a1';
const ORG = '64b0000000000000000000f1';

describe('ownDealershipVehicleFilter', () => {
  it('looks the car up in this dealership only', () => {
    expect(ownDealershipVehicleFilter(CAR, ORG)).toEqual({ _id: CAR, organizationId: ORG });
  });
});

describe('quote creation', () => {
  const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/quote.controller.ts'), 'utf8');

  it('uses the dealership-only lookup and refuses other cars with a plain message', () => {
    expect(controller).toContain('Vehicle.findOne(ownDealershipVehicleFilter(normalizedVehicleId, orgId))');
    expect(controller).toContain('throw new ApiError(400, QUOTE_VEHICLE_NOT_IN_INVENTORY)');
    expect(controller).not.toMatch(/Vehicle\.findById\(normalizedVehicleId\)/);
  });

  it('tells staff what to do instead', () => {
    expect(QUOTE_VEHICLE_NOT_IN_INVENTORY).toBe(
      "That vehicle isn't in your dealership's inventory. Pick it from your Inventory, or enter the vehicle details yourself.",
    );
  });
});
