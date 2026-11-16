/**
 * Who sees which car when opening one by its id.
 */
import { isInventoryStaff, vehicleLookupScope } from '../../src/utils/vehicleLookupScope';

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
