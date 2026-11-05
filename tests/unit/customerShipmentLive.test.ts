/**
 * The live map moves with the driver: each new position goes right away to
 * the customer who follows a shipment on that truck, only from pickup until
 * delivery, and only what the map shows. Models and sockets are stand-ins; no
 * database is used.
 */
const chain = (value: () => unknown) => {
  const self: any = { select: () => self, lean: () => Promise.resolve().then(value) };
  return self;
};
const mockLoadFind = jest.fn();
const mockQuoteFind = jest.fn();
const mockFollowers = jest.fn();
const mockEmit = jest.fn();
jest.mock('../../src/models/Load.model', () => ({ __esModule: true, default: { find: (f: unknown) => chain(() => mockLoadFind(f)) } }));
jest.mock('../../src/models/Quote.model', () => ({ __esModule: true, default: { find: (f: unknown) => chain(() => mockQuoteFind(f)) } }));
jest.mock('../../src/services/shipmentFollower', () => ({ __esModule: true, findQuoteFollowers: (q: unknown) => mockFollowers(q) }));
jest.mock('../../src/services/customerShipmentTracking', () => ({ __esModule: true, LIVE_MAP_STATUSES: new Set(['Picked Up', 'In-Transit']) }));
jest.mock('../../src/services/loadRoute.service', () => ({ __esModule: true, APPROXIMATE_POSITION_METERS: 1000 }));
jest.mock('../../src/utils/socketEmitter', () => ({ __esModule: true, emitToUser: (...args: unknown[]) => mockEmit(...args) }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import {
  CUSTOMER_LOCATION_EVENT,
  FOLLOWER_CACHE_MS,
  emitLocationToShipmentFollowers,
  forgetShipmentFollowers,
} from '../../src/services/customerShipmentLive';

const ORG = '64b0000000000000000000a1';
const OTHER_ORG = '64b0000000000000000000a2';
const LOAD = '64b0000000000000000000b1';
const LOAD2 = '64b0000000000000000000b2';
const QUOTE = '64b0000000000000000000e1';
const QUOTE2 = '64b0000000000000000000e2';
const CUSTOMER = '64b0000000000000000000c9';
const NOW = Date.parse('2026-11-06T17:00:00Z');

const location = (extra: Record<string, unknown> = {}) => ({
  coords: { lat: 40.5, lng: -105.08 }, locationRecordedAt: new Date('2026-11-06T16:59:58Z'), accuracy: 12, speed: 31, heading: 90, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  forgetShipmentFollowers();
  mockLoadFind.mockReturnValue([{ _id: LOAD, quoteId: QUOTE, organizationId: ORG }]);
  mockQuoteFind.mockReturnValue([{ _id: QUOTE, organizationId: ORG, source: 'customer_portal', requestedBy: CUSTOMER }]);
  mockFollowers.mockResolvedValue(new Map([[QUOTE, { id: CUSTOMER, name: 'Maria', email: 'maria@example.com', kind: 'request' }]]));
});

describe('who gets the live position', () => {
  it('the customer following a shipment that is on the truck, with only what the map shows', async () => {
    const sent = await emitLocationToShipmentFollowers([{ _id: LOAD, status: 'In-Transit' }], location(), NOW);
    expect(sent).toBe(1);
    expect(mockEmit).toHaveBeenCalledWith(CUSTOMER, CUSTOMER_LOCATION_EVENT, {
      quoteId: QUOTE,
      driver: { position: { lat: 40.5, lng: -105.08 }, measuredAt: '2026-11-06T16:59:58.000Z', approximate: false },
    });
    // Never the speed, heading or accuracy itself.
    expect(JSON.stringify(mockEmit.mock.calls)).not.toMatch(/speed|heading|accuracy/);
  });

  it('nobody before pickup or after delivery', async () => {
    for (const status of ['Accepted', 'Assigned', 'Delivered', 'Cancelled']) {
      expect(await emitLocationToShipmentFollowers([{ _id: LOAD, status }], location(), NOW)).toBe(0);
    }
    expect(mockLoadFind).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('nobody when no customer follows it, it was unlinked, or the quote is another dealership’s', async () => {
    mockFollowers.mockResolvedValueOnce(new Map());
    expect(await emitLocationToShipmentFollowers([{ _id: LOAD, status: 'Picked Up' }], location(), NOW)).toBe(0);

    forgetShipmentFollowers();
    mockQuoteFind.mockReturnValueOnce([{ _id: QUOTE, organizationId: OTHER_ORG, source: 'customer_portal', requestedBy: CUSTOMER }]);
    expect(await emitLocationToShipmentFollowers([{ _id: LOAD, status: 'Picked Up' }], location(), NOW)).toBe(0);

    forgetShipmentFollowers();
    mockLoadFind.mockReturnValueOnce([{ _id: LOAD, quoteId: null, organizationId: ORG }]);
    expect(await emitLocationToShipmentFollowers([{ _id: LOAD, status: 'Picked Up' }], location(), NOW)).toBe(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('says when the position is rough, and sends nothing without a usable position', async () => {
    await emitLocationToShipmentFollowers([{ _id: LOAD, status: 'In-Transit' }], location({ accuracy: 2500 }), NOW);
    expect(mockEmit.mock.calls[0][2].driver.approximate).toBe(true);
    for (const bad of [null, { coords: null }, location({ coords: { lat: 'x', lng: 1 } }), location({ locationRecordedAt: null })]) {
      expect(await emitLocationToShipmentFollowers([{ _id: LOAD, status: 'In-Transit' }], bad as any, NOW)).toBe(0);
    }
  });
});

describe('heartbeats stay light', () => {
  it('works out who follows each load once a minute, not on every heartbeat', async () => {
    const loads = [{ _id: LOAD, status: 'In-Transit' }];
    await emitLocationToShipmentFollowers(loads, location(), NOW);
    await emitLocationToShipmentFollowers(loads, location(), NOW + 5_000);
    expect(mockLoadFind).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledTimes(2);

    await emitLocationToShipmentFollowers(loads, location(), NOW + FOLLOWER_CACHE_MS + 1);
    expect(mockLoadFind).toHaveBeenCalledTimes(2);
  });

  it('Unlink takes effect on the next heartbeat', async () => {
    const loads = [{ _id: LOAD, status: 'In-Transit' }];
    await emitLocationToShipmentFollowers(loads, location(), NOW);
    forgetShipmentFollowers();
    mockFollowers.mockResolvedValueOnce(new Map());
    expect(await emitLocationToShipmentFollowers(loads, location(), NOW + 5_000)).toBe(0);
  });

  it('two loads on one truck: each customer gets their own shipment', async () => {
    const OTHER_CUSTOMER = '64b0000000000000000000c8';
    mockLoadFind.mockReturnValueOnce([
      { _id: LOAD, quoteId: QUOTE, organizationId: ORG },
      { _id: LOAD2, quoteId: QUOTE2, organizationId: ORG },
    ]);
    mockQuoteFind.mockReturnValueOnce([
      { _id: QUOTE, organizationId: ORG, source: 'customer_portal', requestedBy: CUSTOMER },
      { _id: QUOTE2, organizationId: ORG, email: 'jo@example.com' },
    ]);
    mockFollowers.mockResolvedValueOnce(new Map([
      [QUOTE, { id: CUSTOMER, kind: 'request' }],
      [QUOTE2, { id: OTHER_CUSTOMER, kind: 'shared' }],
    ]));
    await emitLocationToShipmentFollowers([{ _id: LOAD, status: 'In-Transit' }, { _id: LOAD2, status: 'Picked Up' }], location(), NOW);
    expect(mockEmit.mock.calls.map(([user, , payload]) => [user, payload.quoteId])).toEqual([[CUSTOMER, QUOTE], [OTHER_CUSTOMER, QUOTE2]]);
  });

  it('never throws: the driver’s location is already saved', async () => {
    mockLoadFind.mockImplementationOnce(() => {
      throw new Error('database down');
    });
    await expect(emitLocationToShipmentFollowers([{ _id: LOAD, status: 'In-Transit' }], location(), NOW)).resolves.toBe(0);
  });
});
