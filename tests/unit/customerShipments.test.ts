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
jest.mock('../../src/services/notification.service', () => ({
  __esModule: true,
  default: { createNotification: (...args: unknown[]) => mockCreateNotification(...args) },
}));

import { NOTIFICATION_TYPES } from '../../src/constants/notificationTypes';
import {
  CUSTOMER_SHIPMENTS_ROUTE,
  customerShipmentNotice,
  customerShipmentStage,
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
});

describe('customer shipment notifications', () => {
  const events: CustomerShipmentEvent[] = ['accepted', 'declined', 'unavailable', 'booked', 'on_the_way', 'delivered', 'cancelled', 'closed'];

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
    expect(customerShipmentNotice('on_the_way', {}).message).toBe(
      'Your vehicle was picked up and is on its way to you. You can follow it in My Shipments.',
    );
  });

  it('gives a cancellation reason, never anything else from the dealership', () => {
    const notice = customerShipmentNotice('cancelled', { vehicleName: 'Camry', dealerName: 'Action Auto', reasonLabel: 'Customer cancelled' });
    expect(notice.message).toBe(
      'Action Auto cancelled the shipment for your Camry. Reason: Customer cancelled. Contact them if you have questions.',
    );
  });

  it('notifies only the customer behind a customer portal request, linking to My Shipments', async () => {
    mockQuoteFindOne.mockReturnValue({ requestedBy: CUSTOMER, vehicleName: '2021 Toyota Camry' });
    expect(await notifyQuoteCustomer(ORG, QUOTE, 'booked', { loadNumber: 'LD-7' })).toBe(true);
    expect(mockQuoteFindOne).toHaveBeenCalledWith({ _id: QUOTE, organizationId: ORG, source: 'customer_portal' });
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

  it('never fails the dealership action when the notice fails', async () => {
    mockQuoteFindOne.mockReturnValue({ requestedBy: CUSTOMER });
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
    expect(customerShipmentStage({ status: 'booked' }, { status: 'Assigned' })).toBe('booked');
    expect(customerShipmentStage({ status: 'booked' }, { status: 'Picked Up' })).toBe('picked_up');
    expect(customerShipmentStage({ status: 'booked' }, { status: 'In-Transit' })).toBe('on_the_way');
    expect(customerShipmentStage({ status: 'booked' }, { status: 'Delivered' })).toBe('delivered');
    expect(customerShipmentStage({ status: 'pending' }, { status: 'Cancelled' })).toBe('cancelled');
  });

  it("lists only the customer's own requests, with the newest load from the same dealership and no driver details", async () => {
    mockQuoteFind.mockReturnValue([
      { _id: QUOTE, organizationId: ORG, vehicleName: 'Camry', toAddress: 'Denver, CO', status: 'booked', rate: 950, createdAt: new Date('2026-10-20T00:00:00Z') },
    ]);
    mockLoadFind.mockReturnValue([
      { quoteId: QUOTE, organizationId: OTHER_ORG, loadNumber: 'WRONG', status: 'Delivered', createdAt: new Date('2026-10-23T00:00:00Z') },
      { quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-2', status: 'In-Transit', createdAt: new Date('2026-10-22T00:00:00Z'), inTransitAt: new Date('2026-10-22T10:00:00Z'), assignedDriverId: 'driver-secret' },
      { quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-1', status: 'Cancelled', createdAt: new Date('2026-10-21T00:00:00Z') },
    ]);

    const list = await listCustomerShipments(CUSTOMER);
    expect(mockQuoteFind).toHaveBeenCalledWith({ requestedBy: CUSTOMER, source: 'customer_portal' });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ dealerName: 'Action Auto', stage: 'on_the_way', deliveryAddress: 'Denver, CO' });
    expect(list[0].shipment).toMatchObject({ number: 'LD-2', onTheWayAt: '2026-10-22T10:00:00.000Z', cancelReason: null });
    expect(JSON.stringify(list)).not.toMatch(/driver|WRONG/i);
  });

  it('shows the cancellation reason label only', async () => {
    mockQuoteFind.mockReturnValue([{ _id: QUOTE, organizationId: ORG, status: 'pending', createdAt: new Date() }]);
    mockLoadFind.mockReturnValue([
      { quoteId: QUOTE, organizationId: ORG, loadNumber: 'LD-1', status: 'Cancelled', cancellation: { reason: 'vehicle_unavailable', note: 'internal', at: new Date('2026-10-21T00:00:00Z') } },
    ]);
    const [entry] = await listCustomerShipments(CUSTOMER);
    expect(entry.stage).toBe('cancelled');
    expect(entry.shipment).toMatchObject({ cancelReason: 'Vehicle sold or unavailable', cancelledAt: '2026-10-21T00:00:00.000Z' });
    expect(JSON.stringify(entry)).not.toMatch(/internal/);
  });

  it('returns an empty list without other lookups when there are no requests', async () => {
    mockQuoteFind.mockReturnValue([]);
    expect(await listCustomerShipments(CUSTOMER)).toEqual([]);
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
    mockQuoteFind.mockReturnValue([
      { _id: QUOTE, organizationId: ORG, status: 'rejected', declineReason: 'Too far', createdAt: new Date() },
      { _id: '64b0000000000000000000c2', organizationId: ORG, status: 'rejected', closedReason: 'vehicle_unavailable', declineReason: 'Old', createdAt: new Date() },
    ]);
    mockLoadFind.mockReturnValue([]);
    const [declined, closed] = await listCustomerShipments(CUSTOMER);
    expect(declined).toMatchObject({ stage: 'declined', declineReason: 'Too far' });
    expect(closed).toMatchObject({ stage: 'unavailable', declineReason: null });
  });
});
