/**
 * My Shipments and the customer's shipment notifications. Models are
 * stand-ins; no database is used.
 */
const mockQuoteFind = jest.fn();
const mockQuoteFindOne = jest.fn();
const mockLoadFind = jest.fn();
const mockOrgFind = jest.fn();
const mockOrgFindById = jest.fn();
const mockCreateNotification = jest.fn();
const mockUserFind = jest.fn();
const mockUserFindOne = jest.fn();
const mockUserFindById = jest.fn();
const mockProfileFind = jest.fn();
const mockPortalRequests = jest.fn((): unknown[] => []);
const mockSharedQuotes = jest.fn((_filter?: unknown): unknown[] => []);

const chain = (result: () => unknown) => {
  const self: any = {
    select: () => self,
    sort: () => self,
    limit: () => self,
    lean: () => Promise.resolve(result()),
  };
  return self;
};

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    find: (filter: unknown) => chain(() => mockQuoteFind(filter)),
    findOne: (filter: unknown) => chain(() => mockQuoteFindOne(filter)),
  },
}));
jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: { find: (filter: unknown) => chain(() => mockLoadFind(filter)) },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: {
    find: (filter: unknown) => chain(() => mockOrgFind(filter)),
    findById: (id: unknown) => chain(() => mockOrgFindById(id)),
  },
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: {
    find: (filter: unknown) => chain(() => mockUserFind(filter)),
    findOne: (filter: unknown) => chain(() => mockUserFindOne(filter)),
    findById: (id: unknown) => chain(() => mockUserFindById(id)),
  },
}));
jest.mock('../../src/models/DriverProfile.model', () => ({
  __esModule: true,
  default: { find: (filter: unknown) => chain(() => mockProfileFind(filter)) },
}));
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: (...args: unknown[]) => mockCreateNotification(...args) },
}));
// The chats on each shipment (tested in shipmentChat.service.test.ts).
const mockChatSummaries = jest.fn((_customerId: string, _loads: unknown[]) => Promise.resolve(new Map<string, unknown>()));
jest.mock('../../src/services/shipmentChat.service', () => ({
  __esModule: true,
  customerChatSummaries: (customerId: string, loads: unknown[]) => mockChatSummaries(customerId, loads),
}));

import { NOTIFICATION_TYPES } from '../../src/constants/notificationTypes';
import {
  CUSTOMER_SHIPMENTS_ROUTE,
  customerHearsEvent,
  customerSafePhoto,
  customerShipmentNotice,
  customerShipmentStage,
  truckLabel,
  listCustomerShipments,
  notifyCustomerOfDeletedRequest,
  notifyQuoteCustomer,
  type CustomerShipmentEvent,
} from '../../src/services/customerShipments.service';

const ORG = '64b0000000000000000000a1';
const OTHER_ORG = '64b0000000000000000000a2';
const QUOTE = '64b0000000000000000000q1'.replace('q', 'c');
const CUSTOMER = '64b0000000000000000000c9';

beforeEach(() => {
  jest.clearAllMocks();
  mockOrgFindById.mockReturnValue({ name: 'Action Auto' });
  mockOrgFind.mockReturnValue([{ _id: ORG, name: 'Action Auto' }]);
  // The signed-in customer's own account, and the requester behind a portal request.
  mockUserFindById.mockImplementation((id: unknown) =>
    String(id) === CUSTOMER
      ? { _id: CUSTOMER, name: 'Maria Lopez', email: 'maria@example.com', role: 'customer', emailVerified: true, isActive: true }
      : null,
  );
  mockUserFind.mockReturnValue([]);
  mockUserFindOne.mockReturnValue(null);
  mockProfileFind.mockReturnValue([]);
  mockPortalRequests.mockReturnValue([]);
  mockSharedQuotes.mockReturnValue([]);
  // Portal requests and the staff quotes shared with the customer are two lookups.
  mockQuoteFind.mockImplementation((filter: any) => (filter?.source === 'customer_portal' ? mockPortalRequests() : mockSharedQuotes(filter)));
});

describe('customer shipment notifications', () => {
  const events: CustomerShipmentEvent[] = [
    'accepted', 'declined', 'unavailable', 'booked', 'driver_accepted', 'picked_up', 'on_the_way', 'arrived',
    'delivered', 'finding_driver', 'cancelled', 'closed',
  ];

  it('uses notification types the platform accepts, with plain titles', () => {
    for (const event of events) {
      const notice = customerShipmentNotice(event, { vehicleName: '2021 Toyota Camry', dealerName: 'Action Auto' });
      expect((NOTIFICATION_TYPES as readonly string[]).includes(notice.type)).toBe(true);
      expect(notice.title).toMatch(/^[A-Z]/);
      expect(notice.message).not.toMatch(/undefined|null/);
    }
  });

  it('says who answered and what happens next', () => {
    expect(customerShipmentNotice('accepted', { vehicleName: '2021 Toyota Camry', dealerName: 'Action Auto' }).message).toBe(
      "Action Auto accepted your shipping request for the 2021 Toyota Camry. They'll contact you to arrange the details.",
    );
    expect(customerShipmentNotice('unavailable', { vehicleName: '2021 Toyota Camry' }).message).toBe(
      'The 2021 Toyota Camry is no longer available, so your shipping request was closed.',
    );
    expect(customerShipmentNotice('on_the_way', {}).message).toBe('Your vehicle is on its way to you. You can follow it in My Shipments.');
  });

  it('names the driver and says what to do at each driver step', () => {
    const ctx = { vehicleName: '2021 Toyota Camry', dealerName: 'Action Auto', driverName: 'Mark  Reyes' };
    expect(customerShipmentNotice('driver_accepted', ctx)).toMatchObject({
      type: 'shipment_assigned',
      title: 'Driver Accepted Your Shipment',
      message: 'Mark Reyes accepted the shipment for your 2021 Toyota Camry. You can see your driver and follow each step in My Shipments.',
    });
    expect(customerShipmentNotice('driver_accepted', {}).message).toMatch(/^A driver accepted the shipment for your vehicle./);
    expect(customerShipmentNotice('picked_up', ctx).message).toBe(
      'Your 2021 Toyota Camry was picked up by Mark Reyes. You can follow it in My Shipments.',
    );
    expect(customerShipmentNotice('arrived', ctx).message).toBe('Your driver arrived at the delivery address with your 2021 Toyota Camry.');
    expect(customerShipmentNotice('delivered', ctx).message).toBe(
      "Your 2021 Toyota Camry was delivered. If something isn't right, contact Action Auto.",
    );
    expect(customerShipmentNotice('finding_driver', ctx).message).toBe(
      "The driver for your 2021 Toyota Camry can no longer take it, so Action Auto is finding a new driver. We'll let you know when one accepts.",
    );
    expect(customerShipmentNotice('finding_driver', {}).message).toMatch(/so the dealership is finding a new driver/);
  });

  it('only tells a customer about answers to requests they sent themselves', () => {
    for (const event of ['accepted', 'declined', 'unavailable', 'closed'] as CustomerShipmentEvent[]) {
      expect(customerHearsEvent({ kind: 'shared' }, event)).toBe(false);
      expect(customerHearsEvent({ kind: 'request' }, event)).toBe(true);
    }
    for (const event of ['booked', 'driver_accepted', 'picked_up', 'on_the_way', 'arrived', 'delivered', 'finding_driver', 'cancelled'] as CustomerShipmentEvent[]) {
      expect(customerHearsEvent({ kind: 'shared' }, event)).toBe(true);
    }
  });

  it('gives a cancellation reason, never anything else from the dealership', () => {
    const notice = customerShipmentNotice('cancelled', { vehicleName: 'Camry', dealerName: 'Action Auto', reasonLabel: 'Customer cancelled' });
    expect(notice.message).toBe(
      'Action Auto cancelled the shipment for your Camry. Reason: Customer cancelled. Contact them if you have questions.',
    );
  });

  it('notifies the customer behind a customer portal request, linking to My Shipments', async () => {
    mockQuoteFindOne.mockReturnValue({ source: 'customer_portal', requestedBy: CUSTOMER, vehicleName: '2021 Toyota Camry' });
    expect(await notifyQuoteCustomer(ORG, QUOTE, 'booked', { loadNumber: 'LD-7' })).toBe(true);
    expect(mockQuoteFindOne).toHaveBeenCalledWith({ _id: QUOTE, organizationId: ORG });
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: CUSTOMER,
        organizationId: ORG,
        type: 'shipment_created',
        title: 'Shipment Booked',
        metadata: { quoteId: QUOTE, loadNumber: 'LD-7', route: CUSTOMER_SHIPMENTS_ROUTE },
      }),
    );

    mockQuoteFindOne.mockReturnValue(null);
    expect(await notifyQuoteCustomer(ORG, QUOTE, 'booked')).toBe(false);
    expect(await notifyQuoteCustomer(ORG, 'not-an-id', 'booked')).toBe(false);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it("notifies the verified account that follows a staff quote, but not about the quote's own answers", async () => {
    mockQuoteFindOne.mockReturnValue({ email: 'Maria@Example.com', vehicleName: 'Camry' });
    mockUserFindOne.mockReturnValue({ _id: CUSTOMER, name: 'Maria Lopez', email: 'maria@example.com' });
    expect(await notifyQuoteCustomer(ORG, QUOTE, 'booked', { loadNumber: 'LD-9' })).toBe(true);
    expect(mockUserFindOne).toHaveBeenCalledWith({ email: 'maria@example.com', role: 'customer', emailVerified: true, isActive: true });
    expect(mockCreateNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: CUSTOMER, title: 'Shipment Booked' }));
    expect(await notifyQuoteCustomer(ORG, QUOTE, 'accepted')).toBe(false);
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
  });

  it('tells nobody about a staff quote that was unlinked or whose email has no verified account', async () => {
    mockQuoteFindOne.mockReturnValue({ email: 'maria@example.com', portalShareOff: true });
    mockUserFindOne.mockReturnValue({ _id: CUSTOMER, name: 'Maria Lopez', email: 'maria@example.com' });
    expect(await notifyQuoteCustomer(ORG, QUOTE, 'booked')).toBe(false);
    mockQuoteFindOne.mockReturnValue({ email: 'someone@example.com' });
    mockUserFindOne.mockReturnValue(null);
    expect(await notifyQuoteCustomer(ORG, QUOTE, 'booked')).toBe(false);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('never fails the dealership action when the notice fails', async () => {
    mockQuoteFindOne.mockReturnValue({ source: 'customer_portal', requestedBy: CUSTOMER });
    mockCreateNotification.mockRejectedValueOnce(new Error('down'));
    await expect(notifyQuoteCustomer(ORG, QUOTE, 'delivered')).resolves.toBe(false);
  });
});

describe('My Shipments status', () => {
  it('follows the request, then the shipment', () => {
    expect(customerShipmentStage({ status: 'pending' })).toBe('waiting');
    expect(customerShipmentStage({ status: 'accepted' })).toBe('accepted');
    expect(customerShipmentStage({ status: 'rejected' })).toBe('declined');
    expect(customerShipmentStage({ status: 'rejected', closedReason: 'vehicle_unavailable' })).toBe('unavailable');
    expect(customerShipmentStage({ status: 'rejected', closedReason: 'customer_withdrew' })).toBe('withdrawn');
    expect(customerShipmentStage({ status: 'booked' }, { status: 'Assigned' })).toBe('booked');
    expect(customerShipmentStage({ status: 'booked' }, { status: 'Accepted' })).toBe('driver_accepted');
    expect(customerShipmentStage({ status: 'booked' }, { status: 'Picked Up' })).toBe('picked_up');
    expect(customerShipmentStage({ status: 'booked' }, { status: 'In-Transit' })).toBe('on_the_way');
    expect(customerShipmentStage({ status: 'booked' }, { status: 'Delivered' })).toBe('delivered');
    expect(customerShipmentStage({ status: 'pending' }, { status: 'Cancelled' })).toBe('cancelled');
  });

  it("shows the current driver's arrival, and a search for a new driver after a hand-back", () => {
    const arrived = { at: new Date(), driverId: 'driver-2' };
    expect(customerShipmentStage({}, { status: 'In-Transit', assignedDriverId: 'driver-2', arrivals: { delivery: arrived } })).toBe('arrived');
    expect(customerShipmentStage({}, { status: 'Picked Up', assignedDriverId: 'driver-2', arrivals: { delivery: arrived } })).toBe('arrived');
    // An arrival by a driver who has since handed the load back doesn't count.
    expect(customerShipmentStage({}, { status: 'In-Transit', assignedDriverId: 'driver-3', arrivals: { delivery: arrived } })).toBe('on_the_way');
    const handedBack = [{ acceptedAt: new Date(), endReason: 'removed' }];
    expect(customerShipmentStage({}, { status: 'Posted', assignmentHistory: handedBack })).toBe('finding_driver');
    expect(customerShipmentStage({}, { status: 'Assigned', assignmentHistory: handedBack })).toBe('finding_driver');
    expect(customerShipmentStage({}, { status: 'Accepted', assignmentHistory: handedBack })).toBe('driver_accepted');
    // A driver who never accepted, or a cancellation, isn't a hand-back.
    expect(customerShipmentStage({}, { status: 'Posted', assignmentHistory: [{ endReason: 'reassigned' }] })).toBe('booked');
    expect(customerShipmentStage({}, { status: 'Posted', assignmentHistory: [{ acceptedAt: new Date(), endReason: 'cancelled' }] })).toBe('booked');
  });

  it("describes the driver's truck and only passes photos the website can load", () => {
    expect(truckLabel({ truckYear: 2019, truckMake: 'Peterbilt', truckModel: '389', truckColor: 'White' })).toBe('2019 Peterbilt 389 · White');
    expect(truckLabel({ truckMake: 'Kenworth' })).toBe('Kenworth');
    expect(truckLabel({})).toBeNull();
    expect(truckLabel(null)).toBeNull();
    expect(customerSafePhoto('https://pub-1.r2.dev/avatars/1700000000000-12.jpg')).toBe('https://pub-1.r2.dev/avatars/1700000000000-12.jpg');
    expect(customerSafePhoto('avatars/1700000000000-12.png')).toBe('avatars/1700000000000-12.png');
    expect(customerSafePhoto('db:64b0000000000000000000a1?v=2')).toBe('db:64b0000000000000000000a1?v=2');
    for (const unsafe of ['http://example.com/a.jpg', 'data:image/png;base64,AAAA', 'javascript:alert(1)', 'private/ids/license.jpg', '']) {
      expect(customerSafePhoto(unsafe)).toBeNull();
    }
  });

  it("lists only the customer's own requests, with the newest load from the same dealership", async () => {
    mockPortalRequests.mockReturnValue([
      { _id: QUOTE, organizationId: ORG, source: 'customer_portal', vehicleName: 'Camry', toAddress: 'Denver, CO', status: 'booked', rate: 950, createdAt: new Date('2026-10-20T00:00:00Z') },
    ]);
    mockLoadFind.mockReturnValue([
      { quoteId: QUOTE, organizationId: OTHER_ORG, loadNumber: 'WRONG', status: 'Delivered', createdAt: new Date('2026-10-23T00:00:00Z') },
      { quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-2', status: 'In-Transit', createdAt: new Date('2026-10-22T00:00:00Z'), inTransitAt: new Date('2026-10-22T10:00:00Z'), assignedDriverId: 'driver-secret' },
      { quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-1', status: 'Cancelled', createdAt: new Date('2026-10-21T00:00:00Z') },
    ]);

    const list = await listCustomerShipments(CUSTOMER);
    expect(mockQuoteFind).toHaveBeenCalledWith({ requestedBy: CUSTOMER, source: 'customer_portal' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'request', dealerName: 'Action Auto', stage: 'on_the_way', deliveryAddress: 'Denver, CO', rate: 950 });
    expect(list[0].shipment).toMatchObject({ number: 'LD-2', onTheWayAt: '2026-10-22T10:00:00.000Z', cancelReason: null });
    expect(JSON.stringify(list)).not.toMatch(/WRONG/);
  });

  it("shows the driver's full name, photo and truck once they accept, and nothing else about them", async () => {
    mockPortalRequests.mockReturnValue([{ _id: QUOTE, organizationId: ORG, source: 'customer_portal', status: 'booked', createdAt: new Date() }]);
    mockLoadFind.mockReturnValue([
      { quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-4', status: 'Accepted', assignedDriverId: '64b0000000000000000000d1', acceptedAt: new Date('2026-11-05T15:00:00Z') },
    ]);
    mockUserFind.mockReturnValue([
      { _id: '64b0000000000000000000d1', name: 'Mark Reyes', avatar: 'avatars/1700000000000-12.jpg', phone: '+18015550100', email: 'mark@example.com' },
    ]);
    mockProfileFind.mockReturnValue([{ userId: '64b0000000000000000000d1', truckYear: 2019, truckMake: 'Peterbilt', truckModel: '389' }]);
    const [entry] = await listCustomerShipments(CUSTOMER);
    expect(entry.stage).toBe('driver_accepted');
    expect(entry.driver).toEqual({ name: 'Mark Reyes', photoUrl: 'avatars/1700000000000-12.jpg', truck: '2019 Peterbilt 389' });
    expect(entry.shipment?.driverAcceptedAt).toBe('2026-11-05T15:00:00.000Z');
    expect(JSON.stringify(entry)).not.toMatch(/8015550100|mark@example/);

    // Before a driver accepts, nobody is shown.
    mockLoadFind.mockReturnValue([{ quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-4', status: 'Assigned', assignedDriverId: '64b0000000000000000000d1' }]);
    const [waiting] = await listCustomerShipments(CUSTOMER);
    expect(waiting.driver).toBeNull();
  });

  it('carries the two chats of each booked shipment, and none before booking', async () => {
    const LOAD_ID = '64b0000000000000000000b1';
    const chats = {
      driver: { open: true, readable: true, unread: 1, note: null, name: null },
      dispatcher: { open: true, readable: true, unread: 0, note: null, name: 'Dana' },
    };
    mockChatSummaries.mockResolvedValueOnce(new Map([[LOAD_ID, chats]]));
    mockPortalRequests.mockReturnValue([{ _id: QUOTE, organizationId: ORG, source: 'customer_portal', status: 'booked', createdAt: new Date() }]);
    mockLoadFind.mockReturnValue([{ _id: LOAD_ID, quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-5', status: 'In-Transit', dispatchOwnerId: 'disp-1' }]);
    const [entry] = await listCustomerShipments(CUSTOMER);
    expect(entry.chats).toEqual(chats);
    expect(mockChatSummaries).toHaveBeenCalledWith(CUSTOMER, [expect.objectContaining({ _id: LOAD_ID, dispatchOwnerId: 'disp-1', dealerName: 'Action Auto' })]);

    mockLoadFind.mockReturnValue([]);
    const [waiting] = await listCustomerShipments(CUSTOMER);
    expect(waiting.chats).toBeNull();
  });

  it('still lists shipments when the chats are unavailable', async () => {
    mockChatSummaries.mockRejectedValueOnce(new Error('chat store down'));
    mockPortalRequests.mockReturnValue([{ _id: QUOTE, organizationId: ORG, source: 'customer_portal', status: 'booked', createdAt: new Date() }]);
    mockLoadFind.mockReturnValue([{ _id: 'load-x', quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-6', status: 'Posted' }]);
    const [entry] = await listCustomerShipments(CUSTOMER);
    expect(entry).toMatchObject({ stage: 'booked', chats: null });
  });

  it("adds staff quotes with the customer's verified email once booked, without the dealership's price", async () => {
    const SHARED = '64b0000000000000000000e1';
    const UNBOOKED = '64b0000000000000000000e2';
    mockSharedQuotes.mockReturnValue([
      { _id: SHARED, organizationId: ORG, vehicleName: 'F-150', rate: 1200, miles: 500, status: 'booked', createdAt: new Date('2026-11-04T00:00:00Z') },
      { _id: UNBOOKED, organizationId: ORG, vehicleName: 'Civic', rate: 800, status: 'pending', createdAt: new Date('2026-11-05T00:00:00Z') },
    ]);
    mockLoadFind.mockReturnValue([{ quoteId: SHARED, organizationId: ORG, loadNumber: 'LD-8', status: 'Posted', createdAt: new Date('2026-11-04T01:00:00Z') }]);
    const list = await listCustomerShipments(CUSTOMER);
    expect(mockSharedQuotes).toHaveBeenCalledWith({ email: 'maria@example.com', source: { $ne: 'customer_portal' }, portalShareOff: { $ne: true } });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: SHARED, kind: 'shared', stage: 'booked', rate: null, miles: null, eta: null, requestedAt: null });
  });

  it('never shares staff quotes with an unverified or inactive account', async () => {
    for (const account of [{ emailVerified: false, isActive: true }, { emailVerified: true, isActive: false }, { emailVerified: true, isActive: true, role: 'driver' }]) {
      mockUserFindById.mockReturnValue({ _id: CUSTOMER, email: 'maria@example.com', role: 'customer', ...account });
      mockSharedQuotes.mockClear();
      expect(await listCustomerShipments(CUSTOMER)).toEqual([]);
      expect(mockSharedQuotes).not.toHaveBeenCalled();
    }
  });

  it('shows the cancellation reason label only', async () => {
    mockPortalRequests.mockReturnValue([{ _id: QUOTE, organizationId: ORG, status: 'pending', createdAt: new Date() }]);
    mockLoadFind.mockReturnValue([
      { quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-1', status: 'Cancelled', cancellation: { reason: 'vehicle_unavailable', note: 'internal', at: new Date('2026-10-21T00:00:00Z') } },
    ]);
    const [entry] = await listCustomerShipments(CUSTOMER);
    expect(entry.stage).toBe('cancelled');
    expect(entry.shipment).toMatchObject({ cancelReason: 'Vehicle sold or unavailable', cancelledAt: '2026-10-21T00:00:00.000Z' });
    expect(JSON.stringify(entry)).not.toMatch(/internal/);
  });

  it("shows the load's delivery deadline while the car is coming, never after", async () => {
    const deadline = new Date('2026-11-03T00:00:00Z');
    const entryFor = async (status: string, dates?: Record<string, unknown>) => {
      mockPortalRequests.mockReturnValue([{ _id: QUOTE, organizationId: ORG, source: 'customer_portal', status: 'booked', createdAt: new Date() }]);
      mockLoadFind.mockReturnValue([{ quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-3', status, dates }]);
      const [entry] = await listCustomerShipments(CUSTOMER);
      return entry.shipment?.expectedBy;
    };
    for (const status of ['Posted', 'Accepted', 'Picked Up', 'In-Transit']) {
      expect(await entryFor(status, { deliveryDeadline: deadline })).toBe('2026-11-03T00:00:00.000Z');
    }
    expect(await entryFor('Delivered', { deliveryDeadline: deadline })).toBeNull();
    expect(await entryFor('Cancelled', { deliveryDeadline: deadline })).toBeNull();
    expect(await entryFor('Posted')).toBeNull();
    expect(await entryFor('Posted', { deliveryDeadline: 'not a date' })).toBeNull();
  });

  it('returns an empty list without other lookups when there are no requests', async () => {
    expect(await listCustomerShipments(CUSTOMER)).toEqual([]);
    expect(await listCustomerShipments('not-an-id')).toEqual([]);
    expect(mockLoadFind).not.toHaveBeenCalled();
  });
});

describe('declines and closed requests', () => {
  it("adds the dealership's reason to a decline, without a double period", () => {
    expect(customerShipmentNotice('declined', { vehicleName: 'Camry', dealerName: 'Action Auto', declineReason: "We don't ship to Alaska." }).message).toBe(
      "Action Auto declined your shipping request for the Camry. Reason: We don't ship to Alaska. Contact them if you have questions.",
    );
    expect(customerShipmentNotice('declined', { dealerName: 'Action Auto', declineReason: 'No trucks this week' }).message).toBe(
      'Action Auto declined your shipping request for the vehicle. Reason: No trucks this week. Contact them if you have questions.',
    );
    expect(customerShipmentNotice('declined', { dealerName: 'Action Auto' }).message).toBe(
      'Action Auto declined your shipping request for the vehicle. Contact them if you have questions.',
    );
  });

  it('tells the customer when their request is deleted, from the deleted record', async () => {
    expect(await notifyCustomerOfDeletedRequest(ORG, { _id: QUOTE, requestedBy: CUSTOMER, vehicleName: 'Camry' })).toBe(true);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: CUSTOMER,
        title: 'Shipping Request Closed',
        message: 'Action Auto closed your shipping request for the Camry. Contact them if you have questions.',
        metadata: { quoteId: QUOTE, route: CUSTOMER_SHIPMENTS_ROUTE },
      }),
    );
    expect(await notifyCustomerOfDeletedRequest(ORG, { _id: QUOTE })).toBe(false);
  });

  it('shows the decline reason only on a declined request', async () => {
    mockPortalRequests.mockReturnValue([
      { _id: QUOTE, organizationId: ORG, source: 'customer_portal', status: 'rejected', declineReason: 'Too far', createdAt: new Date('2026-11-02T00:00:00Z') },
      { _id: '64b0000000000000000000c2', organizationId: ORG, source: 'customer_portal', status: 'rejected', closedReason: 'vehicle_unavailable', declineReason: 'Old', createdAt: new Date('2026-11-01T00:00:00Z') },
    ]);
    mockLoadFind.mockReturnValue([]);
    const [declined, closed] = await listCustomerShipments(CUSTOMER);
    expect(declined).toMatchObject({ stage: 'declined', declineReason: 'Too far' });
    expect(closed).toMatchObject({ stage: 'unavailable', declineReason: null });
  });
});
