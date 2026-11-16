// Tests from the November 17, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

// Fakes from vehicleAssignee.test.ts
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { exists: (...args: unknown[]) => exists(...args) },
}));

import fs from 'fs';
import path from 'path';
import { inventoryVersion, newestChange } from '../../src/utils/inventoryVersion';
import { isInventoryStaff, vehicleLookupScope } from '../../src/utils/vehicleLookupScope';
import { carOnTheWayMessage, loadOnTheWay, statusChangedMeanwhile } from '../../src/utils/vehicleStatusChange';
import { ASSIGNED_STAFF_SUMMARY_STAGE, VEHICLE_ASSIGNEE_NOT_STAFF, resolveVehicleAssignee } from '../../src/utils/vehicleAssignee';

// Used by the fakes from vehicleAssignee.test.ts
const exists = jest.fn();

describe('inventoryVersion.test.ts', () => {
  /**
   * The Inventory page's "has anything changed?" stamp.
   */
  const NOW = new Date('2026-11-16T05:42:10.000Z');

  describe('inventoryVersion', () => {
    it('combines the car count, the newest change and the hour', () => {
      expect(inventoryVersion(42, new Date('2026-11-16T05:00:00.000Z'), NOW)).toBe('42:1794805200000:2026-11-16T05');
    });

    it('changes when a car is added or removed, a car changes, or the hour turns', () => {
      const base = inventoryVersion(42, new Date(1000), NOW);
      expect(inventoryVersion(41, new Date(1000), NOW)).not.toBe(base);
      expect(inventoryVersion(42, new Date(2000), NOW)).not.toBe(base);
      expect(inventoryVersion(42, new Date(1000), new Date('2026-11-16T06:00:00.000Z'))).not.toBe(base);
      expect(inventoryVersion(42, new Date(1000), new Date('2026-11-16T05:59:59.000Z'))).toBe(base);
    });

    it('copes with an empty inventory', () => {
      expect(inventoryVersion(0, null, NOW)).toBe('0:0:2026-11-16T05');
    });
  });

  describe('newestChange', () => {
    it('finds the newest change time', () => {
      expect(newestChange([{ updatedAt: '2026-11-01T00:00:00Z' }, { updatedAt: new Date('2026-11-03T00:00:00Z') }, {}])?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
      expect(newestChange([])).toBeNull();
    });
  });

  describe('inventory version route', () => {
    it('is registered before the car-by-id route, for staff only', () => {
      const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/vehicle.route.ts'), 'utf8');
      const version = routes.indexOf("router.get('/inventory-version', staffOnly, vehicleController.getInventoryVersion);");
      expect(version).toBeGreaterThan(-1);
      expect(version).toBeLessThan(routes.indexOf(".route('/:id')"));
    });

    it('counts the same cars as the full inventory list', () => {
      const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/vehicle.controller.ts'), 'utf8');
      expect(controller).toContain('{ $match: { organizationId: req.orgId, isDeleted: false, ...archivedScope(req.query.archived) } }');
      expect(controller).toContain('pipeline.push({ $match: { organizationId: req.orgId, isDeleted: false } });');
      expect(controller).toContain('const filter: any = { isDeleted: false, ...archivedScope(archived) };');
    });
  });
});

describe('vehicleLookupScope.test.ts', () => {
  /**
   * Who sees which car when opening one by its id.
   */
  const MARKETPLACE = { status: 'Ready for Sale', isArchived: { $ne: true } };

  describe('vehicleLookupScope', () => {
    it('gives staff their own dealership in every status', () => {
      expect(vehicleLookupScope({ role: 'employee' }, 'member', 'org-1')).toEqual({ staff: true, filter: { organizationId: 'org-1' } });
      expect(vehicleLookupScope({ role: 'admin' }, 'admin', 'org-1')).toEqual({ staff: true, filter: { organizationId: 'org-1' } });
    });

    it('keeps super admins across dealerships', () => {
      expect(vehicleLookupScope({ role: 'super_admin' }, undefined, undefined)).toEqual({ staff: true, filter: {} });
    });

    it('gives customers, drivers, staff without a dealership and signed-out lookups the marketplace only', () => {
      for (const [user, orgRole, orgId] of [
        [{ role: 'customer' }, 'member', 'org-1'],
        [{ role: 'driver' }, undefined, 'org-1'],
        [{ role: 'employee' }, 'member', undefined],
        [undefined, undefined, 'org-1'],
      ] as const) {
        expect(vehicleLookupScope(user as any, orgRole, orgId)).toEqual({ staff: false, filter: MARKETPLACE });
      }
    });

    it('matches the roles inventory staffOnly lets in', () => {
      expect(isInventoryStaff('employee', 'member')).toBe(true);
      expect(isInventoryStaff('driver', 'member')).toBe(false);
      expect(isInventoryStaff('customer', undefined)).toBe(false);
    });
  });
});

describe('vehicleStatusChange.test.ts', () => {
  /**
   * Inventory's "Change status" when several people work at once.
   */
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
});

describe('vehicleAssignee.test.ts', () => {
  /**
   * Inventory cars are assigned only to active staff of the same dealership, and
   * the inventory list shows the assigned person's name and email only.
   */
  const ORG = '64b000000000000000000001';
  const STAFF = '64b0000000000000000000a1';

  beforeEach(() => exists.mockReset());

  describe('resolveVehicleAssignee', () => {
    it('leaves the assignment alone when the request does not mention it', async () => {
      await expect(resolveVehicleAssignee({ price: 1 }, ORG)).resolves.toEqual({ kind: 'unchanged' });
      expect(exists).not.toHaveBeenCalled();
    });

    it('clears it for null or an empty value', async () => {
      await expect(resolveVehicleAssignee({ assignedTo: null }, ORG)).resolves.toEqual({ kind: 'clear' });
      await expect(resolveVehicleAssignee({ assignedTo: '  ' }, ORG)).resolves.toEqual({ kind: 'clear' });
    });

    it('accepts an active staff member of the same dealership', async () => {
      exists.mockResolvedValue({ _id: STAFF });
      const result = await resolveVehicleAssignee({ assignedTo: { _id: STAFF, name: 'Sam' } }, ORG);
      expect(result).toMatchObject({ kind: 'set' });
      expect(String((result as any).id)).toBe(STAFF);
      expect(exists).toHaveBeenCalledWith({
        _id: STAFF,
        organizationId: ORG,
        role: { $in: ['super_admin', 'admin', 'employee'] },
        isActive: { $ne: false },
      });
    });

    it('refuses anyone else, and anything that is not an account ID', async () => {
      exists.mockResolvedValue(null);
      await expect(resolveVehicleAssignee({ assignedTo: STAFF }, ORG)).rejects.toMatchObject({ statusCode: 400, message: VEHICLE_ASSIGNEE_NOT_STAFF });
      await expect(resolveVehicleAssignee({ assignedTo: { $ne: null } }, ORG)).rejects.toMatchObject({ statusCode: 400 });
      await expect(resolveVehicleAssignee({ assignedTo: 'not-an-id' }, ORG)).rejects.toMatchObject({ statusCode: 400 });
      expect(exists).toHaveBeenCalledTimes(1);
    });
  });

  describe('inventory list', () => {
    it('keeps only the id, name and email of the assigned staff member', () => {
      const shown = (ASSIGNED_STAFF_SUMMARY_STAGE.$addFields.assignedTo.$cond[1]) as Record<string, string>;
      expect(Object.keys(shown).sort()).toEqual(['_id', 'email', 'name']);
    });

    it('uses that summary instead of the whole account', () => {
      const controller = fs.readFileSync(path.join(__dirname, '../../src/controllers/vehicle.controller.ts'), 'utf8');
      expect(controller).toContain('ASSIGNED_STAFF_SUMMARY_STAGE,');
      expect(controller).not.toContain('"assignedTo.otp"');
      expect(controller.match(/resolveVehicleAssignee\(req\.body, orgId\)/g)).toHaveLength(2);
    });
  });
});
