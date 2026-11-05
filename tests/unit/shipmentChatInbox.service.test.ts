/**
 * Dispatch Chat's Customers section: a driver or dispatcher sees only the
 * customer chats they're in right now (the same rules as on the load), newest
 * first, with unread counts. Models and the chat service are stand-ins; no
 * database is used.
 */
const chain = (value: () => unknown) => {
  const self: any = {
    select: () => self,
    sort: () => self,
    limit: () => self,
    lean: () => Promise.resolve().then(value),
  };
  return self;
};

const mockThreadFind = jest.fn();
const mockLoadFind = jest.fn();
const mockQuoteFind = jest.fn();
const mockReceiptFind = jest.fn();
const mockOrgFind = jest.fn();
const mockAggregate = jest.fn();
const mockFollowers = jest.fn();
const mockDispatchers = jest.fn();

jest.mock('../../src/models/ShipmentChatThread.model', () => ({ __esModule: true, default: { find: (f: unknown) => chain(() => mockThreadFind(f)) } }));
jest.mock('../../src/models/Load.model', () => ({ __esModule: true, default: { find: (f: unknown) => chain(() => mockLoadFind(f)) } }));
jest.mock('../../src/models/Quote.model', () => ({ __esModule: true, default: { find: (f: unknown) => chain(() => mockQuoteFind(f)) } }));
jest.mock('../../src/models/ShipmentReview.model', () => ({ __esModule: true, default: { find: (f: unknown) => chain(() => mockReceiptFind(f)) } }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { find: (f: unknown) => chain(() => mockOrgFind(f)) } }));
jest.mock('../../src/models/ShipmentChatMessage.model', () => ({ __esModule: true, default: { aggregate: (p: unknown) => mockAggregate(p) } }));
jest.mock('../../src/services/shipmentFollower', () => ({ __esModule: true, findQuoteFollowers: (q: unknown) => mockFollowers(q) }));
jest.mock('../../src/services/shipmentChat.service', () => ({
  __esModule: true,
  CHAT_LOAD_FIELDS: '_id organizationId quoteId loadNumber status assignedDriverId deliveredAt dispatchOwnerId createdBy',
  loadDispatchers: (loads: unknown) => mockDispatchers(loads),
}));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { customerChatUnreadTotal, listCustomerChatInbox } from '../../src/services/shipmentChatInbox.service';

const ORG = '64b0000000000000000000a1';
const OTHER_ORG = '64b0000000000000000000a2';
const CUSTOMER = '64b0000000000000000000c9';
const OTHER_CUSTOMER = '64b0000000000000000000c8';
const DRIVER = '64b0000000000000000000d1';
const OTHER_DRIVER = '64b0000000000000000000d2';
const DISPATCHER = '64b0000000000000000000f1';
const OTHER_DISPATCHER = '64b0000000000000000000f2';
const NOW = Date.parse('2026-11-05T18:00:00Z');

const ids = (n: number) => ({
  load: `64b00000000000000000b${String(n).padStart(3, '0')}`,
  quote: `64b00000000000000000e${String(n).padStart(3, '0')}`,
  thread: `64b00000000000000000f${String(n).padStart(3, '0')}`,
});
const load = (n: number, extra: Record<string, unknown> = {}) => ({
  _id: ids(n).load, organizationId: ORG, quoteId: ids(n).quote, loadNumber: `L-${n}`, status: 'In-Transit',
  assignedDriverId: DRIVER, dispatchOwnerId: DISPATCHER, deliveredAt: null, ...extra,
});
const quote = (n: number, extra: Record<string, unknown> = {}) => ({
  _id: ids(n).quote, organizationId: ORG, source: 'customer_portal', requestedBy: CUSTOMER, vehicleName: `Car ${n}`, ...extra,
});
const thread = (n: number, extra: Record<string, unknown> = {}) => ({
  _id: ids(n).thread, loadId: ids(n).load, quoteId: ids(n).quote, customerId: CUSTOMER, closedAt: null,
  lastMessageAt: new Date(Date.UTC(2026, 10, 5, 12, n)), lastMessagePreview: `Message ${n}`, lastMessageSenderId: CUSTOMER, ...extra,
});

const driver = { _id: DRIVER, role: 'driver' };
const dispatcher = { _id: DISPATCHER, role: 'employee' };

let loads: any[];
let quotes: any[];
let threads: any[];

beforeEach(() => {
  jest.clearAllMocks();
  loads = [load(1)];
  quotes = [quote(1)];
  threads = [thread(1)];
  mockThreadFind.mockImplementation(() => threads);
  mockLoadFind.mockImplementation(() => loads);
  mockQuoteFind.mockImplementation(() => quotes);
  mockReceiptFind.mockReturnValue([]);
  mockOrgFind.mockReturnValue([{ _id: ORG, name: 'Action Auto Utah' }]);
  mockAggregate.mockResolvedValue([]);
  mockFollowers.mockImplementation((list: any[]) =>
    Promise.resolve(new Map(list.map((q) => [String(q._id), { id: CUSTOMER, name: 'Maria Lopez', email: 'maria@example.com', kind: 'request' }]))),
  );
  mockDispatchers.mockImplementation((list: any[]) => Promise.resolve(new Map(list.map((l) => [String(l._id), { id: DISPATCHER, name: 'Dana Dispatch' }]))));
});

describe("the driver's customer chats", () => {
  it('lists their chats newest first, with the customer, car, dealership and unread count', async () => {
    mockAggregate.mockResolvedValueOnce([{ _id: ids(1).thread, n: 2 }]);
    const inbox = await listCustomerChatInbox(driver, undefined, NOW);
    expect(mockThreadFind).toHaveBeenCalledWith({ staffId: DRIVER, kind: 'driver', active: true, lastMessageAt: { $ne: null } });
    expect(inbox).toEqual({
      unreadTotal: 2,
      chats: [{
        loadId: ids(1).load, threadId: ids(1).thread, kind: 'driver', customerName: 'Maria Lopez', vehicleName: 'Car 1',
        loadNumber: 'L-1', dealerName: 'Action Auto Utah', lastMessageAt: '2026-11-05T12:01:00.000Z',
        lastMessagePreview: 'Message 1', lastMessageMine: false, unread: 2, open: true,
      }],
    });
    expect(mockDispatchers).not.toHaveBeenCalled();
  });

  it('leaves out chats on loads that are no longer theirs, or not accepted any more', async () => {
    loads = [load(1, { assignedDriverId: OTHER_DRIVER }), load(2, { status: 'Assigned' }), load(3)];
    quotes = [quote(1), quote(2), quote(3)];
    threads = [thread(3), thread(2), thread(1)];
    const inbox = await listCustomerChatInbox(driver, undefined, NOW);
    expect(inbox.chats.map((chat) => chat.loadId)).toEqual([ids(3).load]);
  });

  it('keeps a closed chat readable: after delivery, cancellation or the customer confirming', async () => {
    loads = [
      load(1, { status: 'Delivered', deliveredAt: new Date(NOW - 2 * 24 * 60 * 60 * 1000) }),
      load(2, { status: 'Cancelled' }),
      load(3, { status: 'Delivered', deliveredAt: new Date(NOW - 60 * 60 * 1000) }),
    ];
    quotes = [quote(1), quote(2), quote(3)];
    threads = [thread(1), thread(2), thread(3)];
    mockReceiptFind.mockReturnValueOnce([{ loadId: ids(3).load }]);
    const inbox = await listCustomerChatInbox(driver, undefined, NOW);
    expect(inbox.chats.map((chat) => [chat.loadNumber, chat.open])).toEqual([['L-1', false], ['L-2', false], ['L-3', false]]);
  });

  it("leaves out a chat whose customer no longer follows the shipment, or follows it from another account", async () => {
    loads = [load(1), load(2)];
    quotes = [quote(1, { source: 'staff', portalShareOff: true }), quote(2)];
    threads = [thread(1), thread(2)];
    mockFollowers.mockResolvedValueOnce(new Map([[ids(2).quote, { id: OTHER_CUSTOMER, name: 'Someone', email: 'x@example.com', kind: 'shared' }]]));
    expect((await listCustomerChatInbox(driver, undefined, NOW)).chats).toEqual([]);
  });

  it('marks chats where the viewer wrote last', async () => {
    threads = [thread(1, { lastMessageSenderId: DRIVER })];
    expect((await listCustomerChatInbox(driver, undefined, NOW)).chats[0].lastMessageMine).toBe(true);
  });
});

describe("the dispatcher's customer chats", () => {
  it("lists only the dealership's loads they're the dispatcher of", async () => {
    loads = [load(1), load(2), load(3, { organizationId: OTHER_ORG })];
    quotes = [quote(1), quote(2), quote(3, { organizationId: OTHER_ORG })];
    threads = [thread(1), thread(2), thread(3)];
    mockDispatchers.mockResolvedValueOnce(new Map([
      [ids(1).load, { id: DISPATCHER, name: 'Dana Dispatch' }],
      [ids(2).load, { id: OTHER_DISPATCHER, name: 'Other' }],
      [ids(3).load, { id: DISPATCHER, name: 'Dana Dispatch' }],
    ]));
    const inbox = await listCustomerChatInbox(dispatcher, ORG, NOW);
    expect(mockThreadFind).toHaveBeenCalledWith({ staffId: DISPATCHER, kind: 'dispatcher', active: true, lastMessageAt: { $ne: null }, organizationId: ORG });
    expect(inbox.chats.map((chat) => [chat.loadId, chat.kind])).toEqual([[ids(1).load, 'dispatcher']]);
  });

  it('a chat the dispatcher closed, or one the customer confirmed, can still be read', async () => {
    loads = [load(1), load(2)];
    quotes = [quote(1), quote(2)];
    threads = [thread(1, { closedAt: new Date() }), thread(2)];
    mockReceiptFind.mockReturnValueOnce([{ loadId: ids(2).load }]);
    const inbox = await listCustomerChatInbox(dispatcher, ORG, NOW);
    expect(inbox.chats.map((chat) => chat.open)).toEqual([false, false]);
  });

  it("a load that doesn't come from the thread's quote any more is left out", async () => {
    loads = [load(1, { quoteId: ids(9).quote })];
    expect((await listCustomerChatInbox(dispatcher, ORG, NOW)).chats).toEqual([]);
  });
});

describe('who can ask', () => {
  it('customers and other roles are refused; staff must choose a dealership', async () => {
    await expect(listCustomerChatInbox({ _id: CUSTOMER, role: 'customer' }, ORG)).rejects.toMatchObject({ statusCode: 403 });
    await expect(listCustomerChatInbox({ _id: DISPATCHER, role: 'employee' }, undefined)).rejects.toMatchObject({ statusCode: 403 });
    expect(mockThreadFind).not.toHaveBeenCalled();
  });

  it('with no chats, nothing else is looked up', async () => {
    threads = [];
    expect(await listCustomerChatInbox(driver, undefined, NOW)).toEqual({ chats: [], unreadTotal: 0 });
    expect(mockLoadFind).not.toHaveBeenCalled();
    expect(mockAggregate).not.toHaveBeenCalled();
  });
});

describe('the unread count for the Dispatch Chat badges', () => {
  it('adds up every chat, and never fails the badge', async () => {
    loads = [load(1), load(2)];
    quotes = [quote(1), quote(2)];
    threads = [thread(1), thread(2)];
    mockAggregate.mockResolvedValueOnce([{ _id: ids(1).thread, n: 2 }, { _id: ids(2).thread, n: 3 }]);
    expect(await customerChatUnreadTotal(driver, undefined)).toBe(5);

    mockThreadFind.mockImplementationOnce(() => {
      throw new Error('database down');
    });
    expect(await customerChatUnreadTotal(driver, undefined)).toBe(0);
    expect(await customerChatUnreadTotal({ _id: CUSTOMER, role: 'customer' }, ORG)).toBe(0);
  });
});
