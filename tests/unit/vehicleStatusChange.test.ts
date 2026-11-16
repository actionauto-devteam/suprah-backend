/**
 * Inventory's "Change status" when several people work at once.
 */
import fs from 'fs';
import path from 'path';
import { carOnTheWayMessage, loadOnTheWay, statusChangedMeanwhile } from '../../src/utils/vehicleStatusChange';

describe('statusChangedMeanwhile', () => {
  it('lets the change through when the status is what the person saw, or they sent none', () => {
    expect(statusChangedMeanwhile('Ready for Sale', 'Ready for Sale')).toBeNull();
    expect(statusChangedMeanwhile('Ready for Sale', undefined)).toBeNull();
    expect(statusChangedMeanwhile('Ready for Sale', '')).toBeNull();
  });

  it('names the new status when someone else changed it', () => {
    expect(statusChangedMeanwhile('Sold', 'Ready for Sale')).toBe(
      'Someone else changed this car to Sold while you were choosing. Check its status now, then try again if it still needs a change.',
    );
  });
});

describe('loadOnTheWay', () => {
  it('finds a load that is picked up or in transit', () => {
    expect(loadOnTheWay([{ loadNumber: 'LD-1', status: 'Assigned' }, { loadNumber: 'LD-2', status: 'In-Transit' }])).toEqual({ loadNumber: 'LD-2' });
    expect(loadOnTheWay([{ loadNumber: 'LD-3', status: 'Picked Up' }])).toEqual({ loadNumber: 'LD-3' });
  });

  it('ignores loads that are not on their way yet', () => {
    expect(loadOnTheWay([{ loadNumber: 'LD-1', status: 'Assigned' }, { loadNumber: 'LD-4', status: 'Accepted' }])).toBeNull();
    expect(loadOnTheWay([])).toBeNull();
  });

  it('says why the status can\'t change', () => {
    expect(carOnTheWayMessage('LD-2')).toBe(
      "This car is on load LD-2, which is on its way. Its status changes by itself at delivery, so it can't be changed until then.",
    );
  });
});

describe('Change status handler', () => {
  const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/vehicle.controller.ts'), 'utf8');

  it('saves only if the status is still the one it checked', () => {
    expect(controller).toContain('{ _id: req.params.id, organizationId: orgId, isDeleted: false, status: current.status ?? null }');
  });

  it('checks for a load on its way before changing the status', () => {
    expect(controller).toMatch(/findVehicleShipping\(orgId, \{ vehicleIds: \[String\(req\.params\.id\)\], vins: \[current\.vin\] \}\)/);
  });
});
