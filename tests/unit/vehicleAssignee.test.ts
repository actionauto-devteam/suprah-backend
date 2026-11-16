/**
 * Inventory cars are assigned only to active staff of the same dealership, and
 * the inventory list shows the assigned person's name and email only.
 */
import fs from 'fs';
import path from 'path';

const exists = jest.fn();
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { exists: (...args: unknown[]) => exists(...args) },
}));

import {
  ASSIGNED_STAFF_SUMMARY_STAGE,
  VEHICLE_ASSIGNEE_NOT_STAFF,
  resolveVehicleAssignee,
} from '../../src/utils/vehicleAssignee';

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
