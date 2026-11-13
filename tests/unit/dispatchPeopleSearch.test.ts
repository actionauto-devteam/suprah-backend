/**
 * Dispatch Chat's people search finds only the people each person works with
 * (2026-11-13): never every driver and staff member on Suprah AI.
 */
import { CHANNEL_STAFF_ROLES, peopleSearchScope } from '../../src/utils/dispatchPeopleSearch';

const VIEWER = '64b000000000000000000001';
const MATE = '64b000000000000000000002';
const OTHER_MATE = '64b000000000000000000003';
const DEALERSHIP = '64a000000000000000000001';
const OTHER_DEALERSHIP = '64a000000000000000000002';

describe('people search: dealership staff', () => {
  it.each(['employee', 'admin'])('%s finds drivers, their own dealership staff and channel mates', (role) => {
    const scope = peopleSearchScope(
      { id: VIEWER, role, organizationId: DEALERSHIP },
      { channelMateIds: [VIEWER, MATE, MATE] },
    );
    expect(scope).toEqual([
      { role: 'driver' },
      { role: { $in: CHANNEL_STAFF_ROLES }, organizationId: DEALERSHIP },
      { _id: { $in: [MATE] } },
    ]);
  });

  it("never matches other dealerships' staff", () => {
    const scope = peopleSearchScope({ id: VIEWER, role: 'admin', organizationId: DEALERSHIP });
    expect(JSON.stringify(scope)).not.toContain(OTHER_DEALERSHIP);
    expect(scope).not.toContainEqual({ role: { $in: CHANNEL_STAFF_ROLES } });
  });

  it('without a signed-in dealership, finds only drivers and channel mates', () => {
    expect(peopleSearchScope({ id: VIEWER, role: 'employee', organizationId: 'global' }, { channelMateIds: [MATE] })).toEqual([
      { role: 'driver' },
      { _id: { $in: [MATE] } },
    ]);
    expect(peopleSearchScope({ id: VIEWER, role: 'employee' })).toEqual([{ role: 'driver' }]);
  });
});

describe('people search: drivers', () => {
  it("finds staff and fellow drivers of the dealerships they've hauled for, and channel mates", () => {
    const scope = peopleSearchScope(
      { id: VIEWER, role: 'driver' },
      {
        haulOrganizationIds: [DEALERSHIP, OTHER_DEALERSHIP, DEALERSHIP],
        fellowDriverIds: [VIEWER, OTHER_MATE],
        channelMateIds: [MATE, OTHER_MATE],
      },
    );
    expect(scope).toEqual([
      { role: { $in: CHANNEL_STAFF_ROLES }, organizationId: { $in: [DEALERSHIP, OTHER_DEALERSHIP] } },
      { role: 'driver', _id: { $in: [OTHER_MATE] } },
      { _id: { $in: [MATE, OTHER_MATE] } },
    ]);
  });

  it('never finds every driver or the whole platform', () => {
    const scope = peopleSearchScope({ id: VIEWER, role: 'driver' }, { haulOrganizationIds: [DEALERSHIP] });
    expect(scope).not.toContainEqual({ role: 'driver' });
    expect(scope).toHaveLength(1);
  });

  it('a new driver with no loads and no channels finds nobody yet', () => {
    expect(peopleSearchScope({ id: VIEWER, role: 'driver' }, { haulOrganizationIds: [], channelMateIds: [VIEWER] })).toEqual([]);
  });

  it('ignores ids that are not real record ids', () => {
    const scope = peopleSearchScope(
      { id: VIEWER, role: 'driver' },
      {
        haulOrganizationIds: ['', null, 'global', 'not-an-id-at-all', { $ne: null }],
        fellowDriverIds: [{ $gt: '' }, 'abcdefghijkl'],
        channelMateIds: [undefined, 'x'],
      },
    );
    expect(scope).toEqual([]);
  });
});

describe('people search: everyone else', () => {
  it('the Suprah AI team (super admins) finds every driver and staff member', () => {
    expect(peopleSearchScope({ id: VIEWER, role: 'super_admin' })).toEqual([
      { role: { $in: [...CHANNEL_STAFF_ROLES, 'driver'] } },
    ]);
  });

  it.each(['customer', '', 'unknown'])('role "%s" finds nobody', (role) => {
    expect(peopleSearchScope({ id: VIEWER, role }, { channelMateIds: [MATE] })).toEqual([]);
  });
});
