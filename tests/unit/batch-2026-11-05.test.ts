// Tests from the November 5, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

// Fakes from quotePortalShare.test.ts
jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => ({ select: () => Promise.resolve(mockQuoteFindOne(filter)) }),
    updateOne: (...args: unknown[]) => Promise.resolve(mockQuoteUpdateOne(...args)),
  },
}));
jest.mock('../../src/services/shipmentFollower', () => ({
  __esModule: true,
  isStaffQuote: (quote: { source?: string }) => quote.source !== 'customer_portal',
  findPortalCustomerByEmail: (email: unknown) => mockFindPortalCustomerByEmail(email),
  findPortalCustomersByEmail: jest.fn(),
}));
jest.mock('../../src/services/customerShipments.service', () => ({
  notifyQuoteCustomer: jest.fn(),
  notifyCustomerOfDeletedRequest: jest.fn(),
  listCustomerShipments: jest.fn(),
}));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { invalidateByPrefix: (...args: unknown[]) => mockInvalidate(...args) } }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null }));
jest.mock('../../src/services/customerShipmentLive', () => ({
  __esModule: true,
  announceShipmentSharing: (...args: unknown[]) => mockAnnounce(...args),
  forgetShipmentFollowers: () => mockForget(),
}));

// Used by the fakes from quotePortalShare.test.ts (above the imports, as in that file)
const mockQuoteFindOne = jest.fn();
const mockQuoteUpdateOne = jest.fn();
const mockFindPortalCustomerByEmail = jest.fn();
const mockInvalidate = jest.fn();
const mockAnnounce = jest.fn();
const mockForget = jest.fn();

import fs from 'fs';
import path from 'path';
import { DRIVER_CHAT_AFTER_DELIVERY_MS, customerFacingDispatcherName, dispatcherChatState, driverChatState, isShipmentChatKind, shipmentChatClosedNote } from '../../src/services/shipmentChatAccess';
import quoteController from '../../src/controllers/quote.controller';

describe('customerTrackingRoute.test.ts', () => {
  /**
   * The live map request is for signed-in customer accounts only, rate
   * limited, and never cached. Reads the route file directly so no controllers load.
   */
  const routes = fs
    .readFileSync(path.join(__dirname, '../../src/routes/customerQuoteRequest.routes.ts'), 'utf8')
    .replace(/\s+/g, ' ');

  describe('live map route', () => {
    it('is for customer accounts only, with its own rate limit', () => {
      expect(routes).toContain(
        'router.get( "/:id/tracking", authorize("customer", "The live map is for the customer receiving the vehicle. Staff see the driver on Driver Tracker."), customerTrackingLimiter, quoteController.getShipmentTracking, );',
      );
    });

    it('comes after sign-in and the no-cache header', () => {
      const signIn = routes.indexOf('router.use(auth());');
      const noStore = routes.indexOf('"private, no-store, max-age=0"');
      const tracking = routes.indexOf('"/:id/tracking"');
      expect(signIn).toBeGreaterThan(-1);
      expect(noStore).toBeGreaterThan(signIn);
      expect(tracking).toBeGreaterThan(noStore);
    });
  });
});

describe('shipmentChatAccess.test.ts', () => {
  /**
   * When each customer chat on a shipment is open, and who is in it (decided
   * 2026-11-05). Pure rules, no database.
   */
  const DRIVER = '64b0000000000000000000d1';
  const DISPATCHER = '64b0000000000000000000f1';
  const NOW = Date.parse('2026-11-05T18:00:00Z');

  describe('the dispatcher as customers see them', () => {
    it('is their first name only, or Dispatcher when there is no name', () => {
      expect(customerFacingDispatcherName('Dana  Marie Dispatch')).toBe('Dana');
      expect(customerFacingDispatcherName('  Carl ')).toBe('Carl');
      expect(customerFacingDispatcherName('')).toBe('Dispatcher');
      expect(customerFacingDispatcherName(undefined)).toBe('Dispatcher');
    });
  });

  describe('the driver chat', () => {
    it('opens when the driver accepts and stays open on the way', () => {
      for (const status of ['Accepted', 'Picked Up', 'In-Transit']) {
        expect(driverChatState({ status, assignedDriverId: DRIVER }, NOW)).toEqual({
          open: true, participantId: DRIVER, reason: null, closesAt: null,
        });
      }
    });

    it('is closed before a driver accepts, with nobody in it', () => {
      for (const status of ['Draft', 'Posted', 'Assigned']) {
        expect(driverChatState({ status, assignedDriverId: DRIVER }, NOW)).toMatchObject({ open: false, participantId: null, reason: 'no_driver_yet' });
      }
      expect(driverChatState({ status: 'In-Transit', assignedDriverId: null }, NOW)).toMatchObject({ open: false, reason: 'no_driver_yet' });
    });

    it('stays open for 24 hours after delivery, then closes (the driver can still read it)', () => {
      const deliveredAt = new Date(NOW - 60 * 60 * 1000);
      expect(driverChatState({ status: 'Delivered', assignedDriverId: DRIVER, deliveredAt }, NOW)).toEqual({
        open: true,
        participantId: DRIVER,
        reason: null,
        closesAt: new Date(deliveredAt.getTime() + DRIVER_CHAT_AFTER_DELIVERY_MS).toISOString(),
      });
      const later = deliveredAt.getTime() + DRIVER_CHAT_AFTER_DELIVERY_MS;
      expect(driverChatState({ status: 'Delivered', assignedDriverId: DRIVER, deliveredAt }, later)).toEqual({
        open: false, participantId: DRIVER, reason: 'delivered', closesAt: null,
      });
      expect(driverChatState({ status: 'Delivered', assignedDriverId: DRIVER, deliveredAt: null }, NOW)).toMatchObject({ open: false, reason: 'delivered' });
    });

    it('closes as soon as the customer confirms they received the vehicle, even within the 24 hours', () => {
      const deliveredAt = new Date(NOW - 60 * 60 * 1000);
      expect(driverChatState({ status: 'Delivered', assignedDriverId: DRIVER, deliveredAt }, NOW, true)).toEqual({
        open: false, participantId: DRIVER, reason: 'received', closesAt: null,
      });
    });

    it('closes when the load is cancelled', () => {
      expect(driverChatState({ status: 'Cancelled', assignedDriverId: DRIVER }, NOW)).toMatchObject({ open: false, participantId: DRIVER, reason: 'cancelled' });
    });
  });

  describe('the dispatcher chat', () => {
    it('is open with the load dispatcher until they close it', () => {
      expect(dispatcherChatState(DISPATCHER)).toEqual({ open: true, participantId: DISPATCHER, reason: null, closesAt: null });
      expect(dispatcherChatState(DISPATCHER, true)).toMatchObject({ open: false, participantId: DISPATCHER, reason: 'closed_by_dispatcher' });
    });

    it('closes for good once the customer confirms receipt (the dispatcher can no longer reopen it)', () => {
      expect(dispatcherChatState(DISPATCHER, false, true)).toMatchObject({ open: false, participantId: DISPATCHER, reason: 'received' });
      expect(dispatcherChatState(DISPATCHER, true, true)).toMatchObject({ reason: 'received' });
      expect(shipmentChatClosedNote('dispatcher', 'received', 'customer')).toMatch(/You confirmed you received your vehicle.*support@suprahai\.com/);
    });

    it('is closed when nobody at the dealership can take it', () => {
      expect(dispatcherChatState(null)).toMatchObject({ open: false, participantId: null, reason: 'no_dispatcher' });
      expect(dispatcherChatState('not-an-id')).toMatchObject({ open: false, reason: 'no_dispatcher' });
    });
  });

  describe('what a closed chat says', () => {
    it('tells customers what to do instead, naming the dealership', () => {
      expect(shipmentChatClosedNote('driver', 'no_driver_yet', 'customer')).toMatch(/once a driver accepts.*message the dispatcher/i);
      expect(shipmentChatClosedNote('driver', 'delivered', 'customer')).toMatch(/24 hours after delivery.*dispatcher/i);
      expect(shipmentChatClosedNote('dispatcher', 'not_booked', 'customer', 'Action Auto Utah')).toMatch(/once Action Auto Utah books your shipment/);
      expect(shipmentChatClosedNote('dispatcher', 'no_dispatcher', 'customer', 'Action Auto Utah')).toBe(
        'Nobody at Action Auto Utah can take messages here right now. Try again later. If you need help sooner, contact Suprah AI support at support@suprahai.com.',
      );
      expect(shipmentChatClosedNote('dispatcher', 'closed_by_dispatcher', 'customer', '')).toMatch(/contact Suprah AI support at support@suprahai\.com\.$/);
    });

    it('tells the dispatcher they can reopen what they closed', () => {
      expect(shipmentChatClosedNote('dispatcher', 'closed_by_dispatcher', 'dispatcher')).toMatch(/Reopen it/);
      expect(shipmentChatClosedNote('driver', null, 'driver')).toBeNull();
    });

    it('only accepts the two chats', () => {
      expect(isShipmentChatKind('driver')).toBe(true);
      expect(isShipmentChatKind('dispatcher')).toBe(true);
      expect(isShipmentChatKind('salesperson')).toBe(false);
      expect(isShipmentChatKind(undefined)).toBe(false);
    });
  });
});

describe('quotePortalShare.test.ts', () => {
  /**
   * Staff Unlink a staff quote from the customer's portal (it stops showing in
   * My Shipments and stops sending updates) or Link it again. Only staff quotes
   * of the staff member's own dealership; a portal request always shows. Models
   * are stand-ins; no database is used.
   */
  const ORG = '64b0000000000000000000a1';
  const QUOTE_ID = '64b0000000000000000000f1';
  const STAFF = '64b0000000000000000000f3';

  function call(id: string, body: unknown) {
    return new Promise<{ status: number; body?: any; error?: any }>((resolve) => {
      const res: any = {
        statusCode: 200,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
      };
      const req: any = { params: { id }, body, orgId: ORG, user: { _id: STAFF, role: 'employee' } };
      quoteController.setPortalShare(req, res, (error: any) => resolve({ status: error?.statusCode, error }));
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockQuoteFindOne.mockReturnValue({ _id: QUOTE_ID, email: 'maria@example.com' });
    mockFindPortalCustomerByEmail.mockResolvedValue({ id: 'c1', name: 'Maria Lopez', email: 'maria@example.com' });
  });

  describe('sharing a staff quote with the customer portal', () => {
    it("unlinks a staff quote in the staff member's own dealership", async () => {
      const result = await call(QUOTE_ID, { share: false });
      expect(result.status).toBe(200);
      expect(mockQuoteFindOne).toHaveBeenCalledWith({ _id: QUOTE_ID, organizationId: ORG });
      const [filter, update] = mockQuoteUpdateOne.mock.calls[0];
      expect(filter).toEqual({ _id: QUOTE_ID, organizationId: ORG });
      expect(update.$set).toMatchObject({ portalShareOff: true, portalShareOffBy: STAFF });
      expect(result.body.data).toEqual({ portalCustomer: { name: 'Maria Lopez', shared: false } });
      expect(result.body.message).toBe('The customer no longer sees this shipment in their portal or gets its updates.');
      expect(mockInvalidate).toHaveBeenCalledWith(`quotes:${ORG}`);
      // The customer, driver and dispatcher see it at once; live positions stop.
      expect(mockForget).toHaveBeenCalled();
      expect(mockAnnounce).toHaveBeenCalledWith(ORG, QUOTE_ID, 'c1', false);
    });

    it('links it again, and says so plainly when no account uses the email', async () => {
      const result = await call(QUOTE_ID, { share: true });
      expect(mockQuoteUpdateOne.mock.calls[0][1]).toEqual({ $unset: { portalShareOff: '', portalShareOffAt: '', portalShareOffBy: '' } });
      expect(result.body.message).toBe('Maria Lopez can follow this shipment in their portal again.');

      mockFindPortalCustomerByEmail.mockResolvedValue(null);
      const none = await call(QUOTE_ID, { share: true });
      expect(none.body.data).toEqual({ portalCustomer: null });
      expect(none.body.message).toMatch(/No verified customer account uses this email yet/);
    });

    it("refuses portal requests, other dealerships' quotes and unclear answers", async () => {
      mockQuoteFindOne.mockReturnValueOnce({ _id: QUOTE_ID, source: 'customer_portal', email: 'maria@example.com' });
      const request = await call(QUOTE_ID, { share: false });
      expect(request.status).toBe(409);
      expect(request.error.message).toMatch(/always shows there/);

      mockQuoteFindOne.mockReturnValueOnce(null);
      expect((await call(QUOTE_ID, { share: false })).status).toBe(404);
      expect((await call('not-an-id', { share: false })).status).toBe(404);
      expect((await call(QUOTE_ID, { share: 'no' })).status).toBe(400);
      expect((await call(QUOTE_ID, {})).status).toBe(400);
      expect(mockQuoteUpdateOne).not.toHaveBeenCalled();
    });
  });
});
