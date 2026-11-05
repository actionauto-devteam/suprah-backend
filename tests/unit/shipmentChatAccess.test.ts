/**
 * When each customer chat on a shipment is open, and who is in it (decided
 * 2026-11-05). Pure rules, no database.
 */
import {
  DRIVER_CHAT_AFTER_DELIVERY_MS,
  dispatcherChatState,
  driverChatState,
  isShipmentChatKind,
  shipmentChatClosedNote,
} from '../../src/services/shipmentChatAccess';

const DRIVER = '64b0000000000000000000d1';
const DISPATCHER = '64b0000000000000000000f1';
const NOW = Date.parse('2026-11-05T18:00:00Z');

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
