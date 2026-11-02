/**
 * Who a driver reaches in Dispatch Chat about a load: the load's dispatcher,
 * then whoever created it, then the dealership's admin, so a switched-off
 * account never leaves the driver with "try again later".
 */
import { loadContactIds, pickLoadContact } from '../../src/services/dispatchChatContact';

const OWNER = '64b0000000000000000000d1';
const CREATOR = '64b0000000000000000000d2';
const ORG = 'org-1';

type Staff = { id: string; organizationId: string };
const staff = (id: string, organizationId = ORG): Staff => ({ id, organizationId });
const sameDealership = (user: Staff) => user.organizationId === ORG;
const admin = staff('admin-1');

describe('loadContactIds', () => {
  it("lists the load's dispatcher first, then whoever created it, once each", () => {
    expect(loadContactIds({ dispatchOwnerId: OWNER, createdBy: CREATOR })).toEqual([OWNER, CREATOR]);
    expect(loadContactIds({ dispatchOwnerId: CREATOR, createdBy: CREATOR })).toEqual([CREATOR]);
    expect(loadContactIds({ createdBy: CREATOR })).toEqual([CREATOR]);
  });

  it('skips missing and invalid ids', () => {
    expect(loadContactIds({ dispatchOwnerId: 'nope', createdBy: null })).toEqual([]);
    expect(loadContactIds(null)).toEqual([]);
  });
});

describe('pickLoadContact', () => {
  const load = { dispatchOwnerId: OWNER, createdBy: CREATOR };

  it("reaches the load's dispatcher when their account is active", () => {
    const active = new Map([[OWNER, staff(OWNER)], [CREATOR, staff(CREATOR)]]);
    expect(pickLoadContact(load, active, admin, sameDealership)).toEqual(staff(OWNER));
  });

  it('reaches whoever created the load when the dispatcher is switched off', () => {
    const active = new Map([[CREATOR, staff(CREATOR)]]);
    expect(pickLoadContact(load, active, admin, sameDealership)).toEqual(staff(CREATOR));
  });

  it("reaches the dealership's admin when nobody on the load can take the chat", () => {
    expect(pickLoadContact(load, new Map(), admin, sameDealership)).toEqual(admin);
    // Someone who moved to another dealership doesn't count.
    const moved = new Map([[OWNER, staff(OWNER, 'other-org')]]);
    expect(pickLoadContact(load, moved, admin, sameDealership)).toEqual(admin);
  });

  it('returns nobody when there is no admin either', () => {
    expect(pickLoadContact(load, new Map(), null, sameDealership)).toBeNull();
    expect(pickLoadContact(load, new Map(), staff('admin-2', 'other-org'), sameDealership)).toBeNull();
  });
});
