/**
 * Shipments on the Suprah Calendar and in Google Calendar: a live load's
 * pickup window and delivery deadline, with no customer details; admins see
 * every live load and others only what they dispatch; each dispatcher's own
 * Google Calendar is kept in step one-way. Models and Google are stand-ins.
 */
const mockLoadFind = jest.fn();
const mockLoadUpdateOne = jest.fn();
const mockUserFindOne = jest.fn();
const mockCrmFindOne = jest.fn();
const mockUpsert = jest.fn();
const mockDelete = jest.fn();

const chain = (result: () => unknown) => {
  const self: any = { select: () => self, sort: () => self, limit: () => self, lean: () => Promise.resolve(result()) };
  return self;
};

jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: {
    find: (filter: unknown) => chain(() => mockLoadFind(filter)),
    updateOne: (...args: unknown[]) => Promise.resolve(mockLoadUpdateOne(...args)),
  },
}));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findOne: (f: unknown) => chain(() => mockUserFindOne(f)) } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findOne: (f: unknown) => chain(() => mockCrmFindOne(f)) } }));
jest.mock('../../src/services/googleCalendar.service', () => ({
  __esModule: true,
  SHIPMENT_EVENT_PROPERTY: 'suprahShipment',
  default: {
    upsertShipmentEvent: (...args: unknown[]) => Promise.resolve(mockUpsert(...args)),
    deleteShipmentEvent: (...args: unknown[]) => Promise.resolve(mockDelete(...args)),
  },
}));
jest.mock('../../src/config', () => ({ __esModule: true, default: { frontendUrl: 'https://app.example.com/' } }));

import {
  googleShipmentEvent,
  listCalendarShipments,
  reconcileLoadGoogleEvents,
  shipmentCalendarEntries,
} from '../../src/services/calendarShipments.service';

const ORG = '64b0000000000000000000a1';
const LOAD = '64b0000000000000000000b1';
const DISPATCHER = '64b0000000000000000000c1';
const CRM = '64b0000000000000000000d1';
const OTHER_CRM = '64b0000000000000000000d2';

const load = (extra: Record<string, unknown> = {}) => ({
  _id: LOAD,
  organizationId: ORG,
  loadNumber: 'LD-7',
  status: 'Posted',
  dispatchOwnerId: DISPATCHER,
  dates: {
    firstAvailable: new Date('2026-11-01T00:00:00Z'),
    pickupDeadline: new Date('2026-11-03T00:00:00Z'),
    deliveryDeadline: new Date('2026-11-06T00:00:00Z'),
  },
  vehicles: [{ year: 2021, make: 'Toyota', model: 'Camry' }],
  pickupLocation: { city: 'Orem', state: 'ut', address: '1 Secret St', contactName: 'Pat', phone: '801' },
  deliveryLocation: { city: 'Denver', state: 'CO', address: '9 Private Rd', contactName: 'Maria Santos', email: 'm@x.com' },
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadUpdateOne.mockReturnValue({ modifiedCount: 1 });
  mockUserFindOne.mockReturnValue({ email: 'Dispatch@Example.com' });
  mockCrmFindOne.mockReturnValue({ _id: CRM, googleCalendar: { calendarConnected: true } });
  mockUpsert.mockImplementation((_target: unknown, eventId: string | null, event: any) => eventId ?? `evt-${event.extendedProperties.private.suprahShipmentKind}`);
  mockDelete.mockReturnValue(true);
});

describe('shipment entries', () => {
  it('gives a live load its pickup window and delivery deadline, with no customer details', () => {
    const entries = shipmentCalendarEntries(load());
    expect(entries).toEqual([
      { kind: 'pickup', title: 'Pickup window: LD-7 · 2021 Toyota Camry · Orem, UT → Denver, CO', startDate: '2026-11-01', endDate: '2026-11-03' },
      { kind: 'delivery', title: 'Delivery deadline: LD-7 · 2021 Toyota Camry · Orem, UT → Denver, CO', startDate: '2026-11-06', endDate: '2026-11-06' },
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/Secret|Private|Maria|Pat|801|m@x/);
  });

  it('handles missing dates and several cars, and nothing for finished loads', () => {
    expect(shipmentCalendarEntries(load({ dates: { pickupDeadline: new Date('2026-11-03T00:00:00Z') } }))).toEqual([
      expect.objectContaining({ kind: 'pickup', startDate: '2026-11-03', endDate: '2026-11-03' }),
    ]);
    expect(shipmentCalendarEntries(load({ vehicles: [{ make: 'Ford' }, {}, {}] }))[0].title).toContain('Ford + 2 more');
    expect(shipmentCalendarEntries(load({ dates: {} }))).toEqual([]);
    expect(shipmentCalendarEntries(load({ status: 'Delivered' }))).toEqual([]);
    expect(shipmentCalendarEntries(load({ status: 'Cancelled' }))).toEqual([]);
  });

  it('becomes an all-day Google event marked as a shipment, linking to the load', () => {
    const [pickup] = shipmentCalendarEntries(load());
    const event = googleShipmentEvent(pickup, LOAD);
    expect(event.start).toEqual({ date: '2026-11-01' });
    expect(event.end).toEqual({ date: '2026-11-04' }); // Google's end date is the day after
    expect(event.transparency).toBe('transparent');
    expect(event.extendedProperties?.private).toEqual({ suprahShipment: LOAD, suprahShipmentKind: 'pickup' });
    expect(event.description).toContain(`https://app.example.com/transportation/load/${LOAD}`);
    expect(event.description).toContain('Suprah AI');
  });
});

describe('Suprah Calendar list', () => {
  it('gives admins every live load and others only what they dispatch', async () => {
    mockLoadFind.mockReturnValue([load()]);
    const items = await listCalendarShipments({ organizationId: ORG, userId: DISPATCHER, isAdmin: true, from: '2026-11-01T06:00:00Z', to: '2026-11-08T06:00:00Z' });
    expect(items.map((item) => item.kind)).toEqual(['pickup', 'delivery']);
    expect(items[0]).toMatchObject({ loadId: LOAD, loadNumber: 'LD-7', status: 'Posted' });
    expect(mockLoadFind.mock.calls[0][0]).not.toHaveProperty('dispatchOwnerId');
    expect(mockLoadFind.mock.calls[0][0]).toMatchObject({ organizationId: ORG, status: { $nin: ['Delivered', 'Cancelled'] } });

    await listCalendarShipments({ organizationId: ORG, userId: DISPATCHER, isAdmin: false, from: '2026-11-01T06:00:00Z', to: '2026-11-08T06:00:00Z' });
    expect(mockLoadFind.mock.calls[1][0]).toMatchObject({ dispatchOwnerId: DISPATCHER });
  });

  it('leaves out entries outside the range and refuses bad input', async () => {
    mockLoadFind.mockReturnValue([load()]);
    const items = await listCalendarShipments({ organizationId: ORG, userId: DISPATCHER, isAdmin: true, from: '2026-11-05T06:00:00Z', to: '2026-11-08T06:00:00Z' });
    expect(items.map((item) => item.kind)).toEqual(['delivery']);
    mockLoadFind.mockClear();
    expect(await listCalendarShipments({ organizationId: ORG, userId: DISPATCHER, isAdmin: true, from: 'soon', to: '2026-11-08' })).toEqual([]);
    expect(await listCalendarShipments({ organizationId: ORG, userId: 'bad', isAdmin: false, from: '2026-11-01', to: '2026-11-08' })).toEqual([]);
    expect(mockLoadFind).not.toHaveBeenCalled();
  });
});

describe('Google Calendar sync', () => {
  const savedState = () => {
    const call = mockLoadUpdateOne.mock.calls.find(([, update]) => update.$set?.calendarSync || update.$unset?.calendarSync !== undefined);
    return call?.[1];
  };

  it("adds both events to the dispatcher's connected calendar", async () => {
    expect(await reconcileLoadGoogleEvents(load())).toBe('synced');
    expect(mockCrmFindOne).toHaveBeenCalledWith({ email: 'dispatch@example.com', organizationId: ORG, isActive: true });
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.calls[0][0]).toEqual({ type: 'crmUser', id: CRM });
    expect(savedState().$set.calendarSync).toMatchObject({ crmUserId: CRM, events: [{ kind: 'pickup', eventId: 'evt-pickup' }, { kind: 'delivery', eventId: 'evt-delivery' }] });
    expect(mockLoadUpdateOne.mock.calls.every(([, , options]) => options?.timestamps === false)).toBe(true);
  });

  it('does nothing when the load and calendar already match', async () => {
    await reconcileLoadGoogleEvents(load());
    const synced = savedState().$set.calendarSync;
    jest.clearAllMocks();
    mockUserFindOne.mockReturnValue({ email: 'Dispatch@Example.com' });
    mockCrmFindOne.mockReturnValue({ _id: CRM, googleCalendar: { calendarConnected: true } });
    expect(await reconcileLoadGoogleEvents(load({ calendarSync: synced }))).toBe('unchanged');
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockLoadUpdateOne).not.toHaveBeenCalled();
  });

  it('removes the events when the load is delivered or cancelled', async () => {
    const calendarSync = { crmUserId: CRM, events: [{ kind: 'pickup', eventId: 'e1' }, { kind: 'delivery', eventId: 'e2' }], fingerprint: 'old' };
    expect(await reconcileLoadGoogleEvents(load({ status: 'Delivered', calendarSync }))).toBe('synced');
    expect(mockDelete.mock.calls.map((call) => call[1])).toEqual(['e1', 'e2']);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(savedState()).toEqual({ $unset: { calendarSync: '' } });
  });

  it('moves the events to the new dispatcher', async () => {
    const calendarSync = { crmUserId: OTHER_CRM, events: [{ kind: 'pickup', eventId: 'old-1' }], fingerprint: 'old' };
    expect(await reconcileLoadGoogleEvents(load({ calendarSync }))).toBe('synced');
    expect(mockDelete).toHaveBeenCalledWith({ type: 'crmUser', id: OTHER_CRM }, 'old-1');
    expect(mockUpsert.mock.calls.every(([target, eventId]) => target.id === CRM && eventId === null)).toBe(true);
  });

  it('removes events when the dispatcher disconnects Google or nobody dispatches the load', async () => {
    const calendarSync = { crmUserId: CRM, events: [{ kind: 'delivery', eventId: 'e2' }], fingerprint: 'old' };
    mockCrmFindOne.mockReturnValue({ _id: CRM, googleCalendar: { calendarConnected: false } });
    expect(await reconcileLoadGoogleEvents(load({ calendarSync }))).toBe('synced');
    expect(mockDelete).toHaveBeenCalledWith({ type: 'crmUser', id: CRM }, 'e2');
    expect(savedState()).toEqual({ $unset: { calendarSync: '' } });
  });

  it('keeps what it had and tries again later when Google refuses', async () => {
    mockUpsert.mockReturnValue(null);
    expect(await reconcileLoadGoogleEvents(load())).toBe('failed');
    expect(savedState()).toEqual({ $unset: { calendarSync: '' } });

    mockDelete.mockReturnValue(false);
    mockLoadUpdateOne.mockClear();
    const calendarSync = { crmUserId: OTHER_CRM, events: [{ kind: 'pickup', eventId: 'old-1' }], fingerprint: 'old' };
    expect(await reconcileLoadGoogleEvents(load({ calendarSync }))).toBe('failed');
    expect(savedState()).toBeUndefined(); // nothing saved when the old event couldn't be removed
  });

  it('skips a load another server is already writing', async () => {
    mockLoadUpdateOne.mockReturnValueOnce({ modifiedCount: 0 });
    expect(await reconcileLoadGoogleEvents(load())).toBe('busy');
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('never syncs a load nobody dispatches', async () => {
    expect(await reconcileLoadGoogleEvents(load({ dispatchOwnerId: null }))).toBe('unchanged');
    expect(mockUserFindOne).not.toHaveBeenCalled();
  });
});
