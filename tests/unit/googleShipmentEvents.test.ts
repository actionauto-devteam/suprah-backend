/**
 * Transportation's shipment events in Google Calendar are one-way: the
 * Google import recognises them and never turns them into appointments.
 */
import { isShipmentEvent, SHIPMENT_EVENT_PROPERTY } from '../../src/services/googleCalendar.service';

describe('isShipmentEvent', () => {
  it('recognises events Transportation wrote', () => {
    expect(isShipmentEvent({ id: 'e1', extendedProperties: { private: { [SHIPMENT_EVENT_PROPERTY]: 'load-1' } } })).toBe(true);
  });

  it('leaves every other Google event to the normal import', () => {
    expect(isShipmentEvent({ id: 'e2', summary: 'Customer appointment' })).toBe(false);
    expect(isShipmentEvent({ id: 'e3', extendedProperties: { private: { somethingElse: 'x' } } })).toBe(false);
    expect(isShipmentEvent({ id: 'e4', extendedProperties: { shared: { [SHIPMENT_EVENT_PROPERTY]: 'load-1' } } })).toBe(false);
    expect(isShipmentEvent(null)).toBe(false);
  });
});
