/**
 * Customer chats on a shipment: only the customer who follows it and the
 * load's CURRENT driver or dispatcher can read or send; a hand-off starts a
 * new, empty chat; closed chats explain what to do instead; every message
 * reaches the other person live and as a notification. Models, storage and
 * sockets are stand-ins; no database is used.
 */
const chain = (value: () => unknown) => {
  const self: any = {
    select: () => self,
    sort: () => self,
    limit: () => self,
    lean: () => Promise.resolve(value()),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(value()).then(resolve, reject),
  };
  return self;
};

const mockQuoteFindById = jest.fn();
const mockQuoteFindOne = jest.fn();
const mockLoadFindById = jest.fn();
const mockLoadFindOne = jest.fn();
const mockUserFind = jest.fn();
const mockUserFindById = jest.fn();
const mockOrgFindById = jest.fn();
const mockThreadUpdateMany = jest.fn();
const mockThreadFindOne = jest.fn();
const mockThreadUpsert = jest.fn();
const mockThreadFind = jest.fn();
const mockThreadUpdateOne = jest.fn();
const mockMessageFind = jest.fn();
const mockMessageFindOne = jest.fn();
const mockMessageCreate = jest.fn();
const mockMessageCount = jest.fn();
const mockMessageUpdateMany = jest.fn();
const mockMessageAggregate = jest.fn();
const mockFollower = jest.fn();
const mockUpload = jest.fn();
const mockSign = jest.fn();
const mockDelete = jest.fn();
const mockEmit = jest.fn();
const mockNotify = jest.fn();

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: { findById: (id: unknown) => chain(() => mockQuoteFindById(id)), findOne: (f: unknown) => chain(() => mockQuoteFindOne(f)) },
}));
jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: { findById: (id: unknown) => chain(() => mockLoadFindById(id)), findOne: (f: unknown) => chain(() => mockLoadFindOne(f)) },
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { find: (f: unknown) => chain(() => mockUserFind(f)), findById: (id: unknown) => chain(() => mockUserFindById(id)) },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: (id: unknown) => chain(() => mockOrgFindById(id)) },
}));
jest.mock('../../src/models/ShipmentChatThread.model', () => ({
  __esModule: true,
  default: {
    updateMany: (...args: unknown[]) => mockThreadUpdateMany(...args),
    findOne: (f: unknown) => chain(() => mockThreadFindOne(f)),
    findOneAndUpdate: (...args: unknown[]) => mockThreadUpsert(...args),
    find: (f: unknown) => chain(() => mockThreadFind(f)),
    updateOne: (...args: unknown[]) => mockThreadUpdateOne(...args),
  },
}));
jest.mock('../../src/models/ShipmentChatMessage.model', () => ({
  __esModule: true,
  default: {
    find: (f: unknown) => chain(() => mockMessageFind(f)),
    findOne: (f: unknown) => chain(() => mockMessageFindOne(f)),
    create: (doc: unknown) => mockMessageCreate(doc),
    countDocuments: (f: unknown) => mockMessageCount(f),
    updateMany: (...args: unknown[]) => mockMessageUpdateMany(...args),
    aggregate: (p: unknown) => mockMessageAggregate(p),
  },
}));
const mockReceiptExists = jest.fn();
const mockReceiptFind = jest.fn();
jest.mock('../../src/models/ShipmentReview.model', () => ({
  __esModule: true,
  default: {
    exists: (f: unknown) => Promise.resolve(mockReceiptExists(f)),
    find: (f: unknown) => chain(() => mockReceiptFind(f)),
  },
}));
jest.mock('../../src/services/shipmentFollower', () => ({ __esModule: true, findQuoteFollower: (q: unknown) => mockFollower(q) }));
jest.mock('../../src/services/customerShipmentTracking', () => ({
  __esModule: true,
  SHIPMENT_NOT_FOUND: "We couldn't find this shipment in your account. Refresh My Shipments and try again.",
}));
jest.mock('../../src/services/storage.service', () => ({
  __esModule: true,
  BucketType: { PUBLIC: 'public', PRIVATE: 'private' },
  storageService: {
    upload: (...args: unknown[]) => mockUpload(...args),
    getSignedUrl: (...args: unknown[]) => mockSign(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
    getKeyFromUrl: (url: string) => url.replace('https://files.example.com/', ''),
  },
}));
jest.mock('../../src/utils/socketEmitter', () => ({ __esModule: true, emitToUser: (...args: unknown[]) => mockEmit(...args) }));
jest.mock('../../src/utils/safeNotification', () => ({ __esModule: true, safeCreateNotification: (p: unknown) => mockNotify(p) }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import {
  CHAT_KIND_INVALID,
  LOAD_CHAT_NOT_FOUND,
  LOAD_NOT_YOURS,
  customerChatSummaries,
  listChatMessages,
  markChatRead,
  resolveCustomerChat,
  resolveLoadChat,
  sendChatMessage,
  setDispatcherChatClosed,
  shipmentChatView,
} from '../../src/services/shipmentChat.service';

const ORG = '64b0000000000000000000a1';
const OTHER_ORG = '64b0000000000000000000a2';
const QUOTE = '64b0000000000000000000e1';
const LOAD = '64b0000000000000000000b1';
const CUSTOMER = '64b0000000000000000000c9';
const OTHER_CUSTOMER = '64b0000000000000000000c8';
const DRIVER = '64b0000000000000000000d1';
const OTHER_DRIVER = '64b0000000000000000000d2';
const DISPATCHER = '64b0000000000000000000f1';
const CREATOR = '64b0000000000000000000f2';
const ADMIN = '64b0000000000000000000f3';
const THREAD = '64b0000000000000000000aa';

const baseLoad = () => ({
  _id: LOAD, organizationId: ORG, quoteId: QUOTE, loadNumber: 'L-1001', status: 'In-Transit',
  assignedDriverId: DRIVER, dispatchOwnerId: DISPATCHER, createdBy: CREATOR, deliveredAt: null,
});
const quote = { _id: QUOTE, organizationId: ORG, source: 'customer_portal', requestedBy: CUSTOMER, vehicleName: '2021 Toyota Camry' };
const thread = (overrides: Record<string, unknown> = {}) => ({
  _id: THREAD, loadId: LOAD, quoteId: QUOTE, kind: 'driver', staffId: DRIVER, customerId: CUSTOMER, closedAt: null, ...overrides,
});
const staff = (id: string, extra: Record<string, unknown> = {}) => ({ _id: id, name: 'Dana Dispatch', role: 'employee', organizationId: ORG, ...extra });

let staffUsers: any[];
let admins: any[];

beforeEach(() => {
  jest.clearAllMocks();
  staffUsers = [staff(DISPATCHER)];
  admins = [];
  mockQuoteFindById.mockReturnValue(quote);
  mockQuoteFindOne.mockReturnValue(quote);
  mockLoadFindById.mockImplementation(() => baseLoad());
  mockLoadFindOne.mockImplementation(() => baseLoad());
  mockUserFind.mockImplementation((filter: any) => (filter._id ? staffUsers : admins));
  mockUserFindById.mockReturnValue({ name: 'Mike Driver' });
  mockOrgFindById.mockReturnValue({ name: 'Action Auto Utah' });
  mockFollower.mockResolvedValue({ id: CUSTOMER, name: 'Maria', email: 'maria@example.com', kind: 'request' });
  mockThreadUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mockThreadFindOne.mockReturnValue(null);
  mockThreadUpsert.mockImplementation((filter: any) => Promise.resolve(thread({ kind: filter.kind, staffId: filter.staffId })));
  mockThreadFind.mockReturnValue([]);
  mockThreadUpdateOne.mockResolvedValue({});
  mockMessageFind.mockReturnValue([]);
  mockMessageFindOne.mockReturnValue(null);
  mockMessageCreate.mockImplementation((doc: any) => {
    const saved = { _id: '64b00000000000000000aaa1', createdAt: new Date('2026-11-05T18:00:00Z'), ...doc };
    return Promise.resolve({ ...saved, toObject: () => saved });
  });
  mockMessageCount.mockResolvedValue(0);
  mockMessageUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  mockMessageAggregate.mockResolvedValue([]);
  mockSign.mockImplementation((key: string) => Promise.resolve(`https://signed.example.com/${key}?sig=1`));
  mockUpload.mockImplementation((file: any) => Promise.resolve(`https://files.example.com/shipment-chat-photos/${file.originalname}`));
  mockDelete.mockResolvedValue(undefined);
  mockNotify.mockResolvedValue({});
  mockReceiptExists.mockReturnValue(null);
  mockReceiptFind.mockReturnValue([]);
});

describe('after the customer confirms they received the vehicle', () => {
  it('both chats close for everyone, and stay readable', async () => {
    mockReceiptExists.mockReturnValue({ _id: 'receipt-1' });
    mockLoadFindOne.mockReturnValue({ ...baseLoad(), status: 'Delivered', deliveredAt: new Date() });
    mockThreadFindOne.mockReturnValue(thread());
    const driverChat = await resolveCustomerChat(CUSTOMER, QUOTE, 'driver');
    expect(await shipmentChatView(driverChat)).toMatchObject({ open: false, threadId: THREAD });
    await expect(sendChatMessage(driverChat, { content: 'Thanks' })).rejects.toMatchObject({
      statusCode: 409, message: expect.stringMatching(/You confirmed you received your vehicle/),
    });

    mockThreadFindOne.mockReturnValue(thread({ kind: 'dispatcher', staffId: DISPATCHER }));
    const staffSide = await shipmentChatView(await resolveLoadChat(staffActor(), ORG, LOAD));
    expect(staffSide).toMatchObject({ open: false, canClose: false, canReopen: false });
    expect(staffSide.note).toMatch(/customer confirmed they received the vehicle/);
  });

  it('My Shipments shows both chats closed', async () => {
    mockReceiptFind.mockReturnValueOnce([{ loadId: LOAD }]);
    const summaries = await customerChatSummaries(CUSTOMER, [{ ...baseLoad(), status: 'Delivered', deliveredAt: new Date() } as any]);
    expect(summaries.get(LOAD)?.driver).toMatchObject({ open: false, readable: true });
    expect(summaries.get(LOAD)?.dispatcher).toMatchObject({ open: false, readable: true });
  });
});

const driverActor = (id = DRIVER) => ({ _id: id, role: 'driver' });
const staffActor = (id = DISPATCHER, role = 'employee') => ({ _id: id, role });

describe('who can open a chat', () => {
  it('only offers the driver and dispatcher chats', async () => {
    await expect(resolveCustomerChat(CUSTOMER, QUOTE, 'salesperson')).rejects.toMatchObject({ statusCode: 400, message: CHAT_KIND_INVALID });
  });

  it("answers 'not found' for anyone else's shipment, an unlinked one, or a bad link", async () => {
    mockFollower.mockResolvedValueOnce({ id: OTHER_CUSTOMER, kind: 'shared' });
    await expect(resolveCustomerChat(CUSTOMER, QUOTE, 'driver')).rejects.toMatchObject({ statusCode: 404 });
    mockFollower.mockResolvedValueOnce(null);
    await expect(resolveCustomerChat(CUSTOMER, QUOTE, 'driver')).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveCustomerChat(CUSTOMER, 'nope', 'driver')).rejects.toMatchObject({ statusCode: 404 });
    expect(mockLoadFindOne).not.toHaveBeenCalled();
  });

  it('before booking, both chats say when they open', async () => {
    mockLoadFindOne.mockReturnValueOnce(null);
    const view = await shipmentChatView(await resolveCustomerChat(CUSTOMER, QUOTE, 'dispatcher'));
    expect(view).toMatchObject({ available: true, open: false, threadId: null });
    expect(view.note).toMatch(/once Action Auto Utah books your shipment/);
    expect(mockThreadFindOne).not.toHaveBeenCalled();
  });

  it("the customer's driver chat is with the driver on the load, from the quote's own dealership", async () => {
    mockThreadFindOne.mockReturnValueOnce(thread());
    mockMessageCount.mockResolvedValueOnce(2);
    const view = await shipmentChatView(await resolveCustomerChat(CUSTOMER, QUOTE, 'driver'));
    expect(mockLoadFindOne).toHaveBeenCalledWith({ quoteId: QUOTE, organizationId: ORG });
    expect(view).toMatchObject({ open: true, isParticipant: true, withName: 'Mike Driver', unread: 2, threadId: THREAD, canClose: false });
  });

  it('a driver who is no longer on the load is shut out', async () => {
    await expect(resolveLoadChat(driverActor(OTHER_DRIVER), ORG, LOAD)).rejects.toMatchObject({ statusCode: 403, message: LOAD_NOT_YOURS });
  });

  it("staff of another dealership can't find the load, and customers can't use the staff side", async () => {
    await expect(resolveLoadChat(staffActor(), OTHER_ORG, LOAD)).rejects.toMatchObject({ statusCode: 404, message: LOAD_CHAT_NOT_FOUND });
    await expect(resolveLoadChat(staffActor(), undefined, LOAD)).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveLoadChat({ _id: CUSTOMER, role: 'customer' }, ORG, LOAD)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('a load nobody follows in the portal has no chat', async () => {
    mockFollower.mockResolvedValueOnce(null);
    const view = await shipmentChatView(await resolveLoadChat(staffActor(), ORG, LOAD));
    expect(view).toMatchObject({ available: false, open: false });
    expect(view.note).toMatch(/No customer follows this load/);
  });

  it('other staff only see who handles the chat, never the messages', async () => {
    const ctx = await resolveLoadChat(staffActor(ADMIN, 'admin'), ORG, LOAD);
    expect(await shipmentChatView(ctx)).toMatchObject({ isParticipant: false, open: false, handledBy: 'Dana Dispatch', threadId: null });
    expect(await listChatMessages(ctx)).toEqual({ messages: [], hasMore: false });
    await expect(sendChatMessage(ctx, { content: 'Hi' })).rejects.toMatchObject({ statusCode: 403 });
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });
});

describe("the load's dispatcher", () => {
  it('is whoever created the load when the dispatcher it was handed to is switched off', async () => {
    staffUsers = [staff(CREATOR, { name: 'Carl Creator' })];
    const view = await shipmentChatView(await resolveCustomerChat(CUSTOMER, QUOTE, 'dispatcher'));
    expect(view).toMatchObject({ open: true, withName: 'Carl' });
  });

  it("is the dealership's longest-serving admin when neither can take it, never staff of another dealership", async () => {
    staffUsers = [staff(DISPATCHER, { organizationId: OTHER_ORG })];
    admins = [staff(ADMIN, { name: 'Ann Admin', role: 'admin' })];
    const view = await shipmentChatView(await resolveCustomerChat(CUSTOMER, QUOTE, 'dispatcher'));
    expect(view).toMatchObject({ open: true, withName: 'Ann' });
    expect(mockUserFind).toHaveBeenLastCalledWith({ organizationId: { $in: [ORG] }, role: 'admin', isActive: true });
  });

  it('with nobody to take it, the customer is told to contact the dealership', async () => {
    staffUsers = [];
    const view = await shipmentChatView(await resolveCustomerChat(CUSTOMER, QUOTE, 'dispatcher'));
    expect(view.open).toBe(false);
    expect(view.note).toMatch(/Nobody at Action Auto Utah can take messages.*support@suprahai\.com/);
  });
});

describe('sending', () => {
  it('a customer message reaches the driver live and as a notification that opens the load', async () => {
    const ctx = await resolveCustomerChat(CUSTOMER, QUOTE, 'driver');
    const { message, repeated } = await sendChatMessage(ctx, { content: '  Hi, is the car on the way?  ', clientMessageId: 'client-123456' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(repeated).toBe(false);
    expect(mockThreadUpsert.mock.calls[0][0]).toEqual({ loadId: LOAD, kind: 'driver', active: true, staffId: DRIVER, customerId: CUSTOMER });
    expect(mockMessageCreate).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: ORG, threadId: THREAD, senderRole: 'customer', content: 'Hi, is the car on the way?', photos: [], clientMessageId: 'client-123456',
    }));
    expect(message).toMatchObject({ mine: true, senderName: 'Maria', senderRole: 'customer', seen: false });

    const live = mockEmit.mock.calls.filter(([, event]) => event === 'shipment-chat:message');
    expect(live.map(([userId, , payload]) => [userId, payload.message.mine])).toEqual([[CUSTOMER, true], [DRIVER, false]]);
    expect(live[0][2]).toMatchObject({ threadId: THREAD, loadId: LOAD, quoteId: QUOTE, kind: 'driver' });

    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      userId: DRIVER,
      organizationId: ORG,
      type: 'message_received',
      title: 'Maria (customer)',
      message: 'About the 2021 Toyota Camry: Hi, is the car on the way?',
      metadata: expect.objectContaining({ route: `/driver/loads/${LOAD}?chat=customer`, pushTag: `shipment-chat:${THREAD}` }),
    }));
  });

  it("the dispatcher's reply notifies the customer with a link to the chat on My Shipments", async () => {
    const ctx = await resolveLoadChat(staffActor(), ORG, LOAD);
    await sendChatMessage(ctx, { content: 'Your car arrives tomorrow.' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      userId: CUSTOMER,
      title: 'Dana (Action Auto Utah)',
      metadata: expect.objectContaining({ route: `/customer/shipments?shipment=${QUOTE}&chat=dispatcher` }),
    }));
    expect(mockMessageCreate).toHaveBeenCalledWith(expect.objectContaining({ senderRole: 'dispatcher' }));
  });

  it('a new driver starts a new, empty chat: the old driver’s thread is retired', async () => {
    await resolveCustomerChat(CUSTOMER, QUOTE, 'driver');
    expect(mockThreadUpdateMany).toHaveBeenCalledWith(
      { loadId: LOAD, kind: 'driver', active: true, $or: [{ staffId: { $ne: DRIVER } }, { customerId: { $ne: CUSTOMER } }] },
      { $set: { active: false, retiredAt: expect.any(Date) } },
    );
    expect(mockThreadFindOne).toHaveBeenCalledWith({ loadId: LOAD, kind: 'driver', active: true, staffId: DRIVER, customerId: CUSTOMER });
  });

  it('asks for something to send, and keeps messages to 4,000 characters', async () => {
    const ctx = await resolveCustomerChat(CUSTOMER, QUOTE, 'driver');
    await expect(sendChatMessage(ctx, { content: '   ' })).rejects.toMatchObject({ statusCode: 400, message: 'Type a message or add a photo before sending.' });
    await expect(sendChatMessage(ctx, { content: 'x'.repeat(4001) })).rejects.toMatchObject({ statusCode: 400 });
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it('a closed chat explains why instead of sending', async () => {
    mockLoadFindOne.mockReturnValueOnce({ ...baseLoad(), status: 'Delivered', deliveredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
    const ctx = await resolveCustomerChat(CUSTOMER, QUOTE, 'driver');
    await expect(sendChatMessage(ctx, { content: 'Thanks!' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/24 hours after delivery/) });
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it('a retried send returns the first message instead of posting it twice', async () => {
    mockMessageFindOne.mockReturnValueOnce({ _id: 'm1', senderId: CUSTOMER, senderRole: 'customer', content: 'Hi', photos: [], readBy: [CUSTOMER], createdAt: new Date() });
    const ctx = await resolveCustomerChat(CUSTOMER, QUOTE, 'driver');
    const result = await sendChatMessage(ctx, { content: 'Hi', clientMessageId: 'client-123456' });
    expect(result.repeated).toBe(true);
    expect(mockMessageCreate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('photos go to private storage, and a failed upload removes the ones already stored', async () => {
    const photo = (name: string) => ({ originalname: name, mimetype: 'image/jpeg', size: 1000, buffer: Buffer.from('x') }) as any;
    const ctx = await resolveCustomerChat(CUSTOMER, QUOTE, 'driver');
    await sendChatMessage(ctx, { photos: [photo('front.jpg')] });
    expect(mockUpload).toHaveBeenCalledWith(expect.objectContaining({ originalname: 'front.jpg' }), 'shipment-chat-photos', 'private', { allowLocalFallback: false });
    expect(mockMessageCreate).toHaveBeenCalledWith(expect.objectContaining({
      content: '', photos: [{ fileKey: 'shipment-chat-photos/front.jpg', originalName: 'front.jpg', mimeType: 'image/jpeg', size: 1000 }],
    }));

    mockUpload.mockImplementationOnce((file: any) => Promise.resolve(`https://files.example.com/shipment-chat-photos/${file.originalname}`));
    mockUpload.mockRejectedValueOnce(new Error('storage down'));
    await expect(sendChatMessage(ctx, { photos: [photo('a.jpg'), photo('b.jpg')] })).rejects.toMatchObject({ statusCode: 503 });
    expect(mockDelete).toHaveBeenCalledWith('shipment-chat-photos/a.jpg', 'private');
  });
});

describe('reading', () => {
  it('shows messages oldest first, 50 at a time, and never an unsigned photo key', async () => {
    mockThreadFindOne.mockReturnValue(thread());
    const rows = Array.from({ length: 51 }, (_, i) => ({
      _id: `m${i}`, senderId: i % 2 ? DRIVER : CUSTOMER, senderRole: i % 2 ? 'driver' : 'customer', content: `#${i}`,
      photos: [], readBy: [CUSTOMER, DRIVER], createdAt: new Date(Date.UTC(2026, 10, 5, 12, 0, 51 - i)),
    }));
    rows[0].photos = [{ fileKey: 'shipment-chat-photos/x.jpg', originalName: 'x.jpg', mimeType: 'image/jpeg', size: 1 }] as any;
    mockMessageFind.mockReturnValueOnce(rows);
    mockSign.mockResolvedValueOnce('shipment-chat-photos/x.jpg');
    const ctx = await resolveCustomerChat(CUSTOMER, QUOTE, 'driver');
    const page = await listChatMessages(ctx);
    expect(page.hasMore).toBe(true);
    expect(page.messages).toHaveLength(50);
    expect(page.messages[49]).toMatchObject({ content: '#0', mine: true, seen: true, photos: [{ url: '', available: false }] });
    expect(page.messages[48]).toMatchObject({ content: '#1', mine: false, senderName: 'Mike Driver' });
  });

  it("customers see the dispatcher's first name only; the dispatcher sees their own full name", async () => {
    mockThreadFindOne.mockReturnValue(thread({ kind: 'dispatcher', staffId: DISPATCHER }));
    const reply = { _id: 'm1', senderId: DISPATCHER, senderRole: 'dispatcher', content: 'On its way', photos: [], readBy: [DISPATCHER], createdAt: new Date() };
    mockMessageFind.mockReturnValueOnce([reply]);
    const customerSide = await resolveCustomerChat(CUSTOMER, QUOTE, 'dispatcher');
    expect((await listChatMessages(customerSide)).messages[0]).toMatchObject({ mine: false, senderName: 'Dana' });

    mockMessageFind.mockReturnValueOnce([reply]);
    const staffSide = await resolveLoadChat(staffActor(), ORG, LOAD);
    expect((await listChatMessages(staffSide)).messages[0]).toMatchObject({ mine: true, senderName: 'Dana Dispatch' });
    expect(await shipmentChatView(staffSide)).toMatchObject({ withName: 'Maria' });
  });

  it('marks what the reader has on screen as read and tells the other person', async () => {
    mockThreadFindOne.mockReturnValue(thread());
    mockMessageUpdateMany.mockResolvedValueOnce({ modifiedCount: 3 });
    const ctx = await resolveLoadChat(driverActor(), ORG, LOAD);
    await markChatRead(ctx, '2026-11-05T18:00:00.000Z');
    const [filter, update] = mockMessageUpdateMany.mock.calls[0];
    expect(filter).toMatchObject({ threadId: THREAD, createdAt: { $lte: new Date('2026-11-05T18:00:00.000Z') } });
    expect(String(filter.readBy.$ne)).toBe(DRIVER);
    expect(String(update.$addToSet.readBy)).toBe(DRIVER);
    expect(mockEmit).toHaveBeenCalledWith(CUSTOMER, 'shipment-chat:read', expect.objectContaining({ readerId: DRIVER, kind: 'driver' }));
  });
});

describe('closing the dispatcher chat', () => {
  it('only the dispatcher can close it', async () => {
    await expect(setDispatcherChatClosed(await resolveLoadChat(driverActor(), ORG, LOAD), true)).rejects.toMatchObject({ statusCode: 403 });
    await expect(setDispatcherChatClosed(await resolveLoadChat(staffActor(ADMIN, 'admin'), ORG, LOAD), true)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('closing stops new messages but keeps the chat readable, and the dispatcher can reopen it', async () => {
    const ctx = await resolveLoadChat(staffActor(), ORG, LOAD);
    await setDispatcherChatClosed(ctx, true);
    expect(mockThreadUpdateOne).toHaveBeenCalledWith({ _id: THREAD }, { $set: { closedAt: expect.any(Date), closedBy: expect.anything() } });
    expect(mockEmit).toHaveBeenCalledWith(CUSTOMER, 'shipment-chat:changed', expect.objectContaining({ kind: 'dispatcher' }));

    mockThreadFindOne.mockReturnValue(thread({ kind: 'dispatcher', staffId: DISPATCHER, closedAt: new Date() }));
    const closed = await resolveLoadChat(staffActor(), ORG, LOAD);
    expect(await shipmentChatView(closed)).toMatchObject({ open: false, canReopen: true, canClose: false, threadId: THREAD });
    const customerSide = await resolveCustomerChat(CUSTOMER, QUOTE, 'dispatcher');
    await expect(sendChatMessage(customerSide, { content: 'Hello?' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/closed this chat/) });
  });
});

describe('My Shipments', () => {
  it("counts unread messages only in each chat with the load's current people", async () => {
    mockThreadFind.mockReturnValueOnce([
      { _id: 'tDriver', loadId: LOAD, kind: 'driver', staffId: DRIVER },
      { _id: 'tOld', loadId: LOAD, kind: 'driver', staffId: OTHER_DRIVER },
      { _id: 'tDisp', loadId: LOAD, kind: 'dispatcher', staffId: DISPATCHER, closedAt: null },
    ]);
    mockMessageAggregate.mockResolvedValueOnce([{ _id: 'tDriver', n: 2 }, { _id: 'tOld', n: 5 }, { _id: 'tDisp', n: 1 }]);
    const summaries = await customerChatSummaries(CUSTOMER, [{ ...baseLoad(), dealerName: 'Action Auto Utah' } as any]);
    expect(summaries.get(LOAD)).toEqual({
      driver: { open: true, readable: true, unread: 2, note: null, name: null },
      dispatcher: { open: true, readable: true, unread: 1, note: null, name: 'Dana' },
    });
  });

  it('after the driver chat closes, the conversation can still be read', async () => {
    const delivered = { ...baseLoad(), status: 'Delivered', deliveredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) };
    const summaries = await customerChatSummaries(CUSTOMER, [delivered as any]);
    expect(summaries.get(LOAD)?.driver).toMatchObject({ open: false, readable: true });
    expect(summaries.get(LOAD)?.driver.note).toMatch(/24 hours after delivery/);
  });

  it('before a driver accepts, the driver chat says to message the dispatcher', async () => {
    const summaries = await customerChatSummaries(CUSTOMER, [{ ...baseLoad(), status: 'Posted', assignedDriverId: null } as any]);
    expect(summaries.get(LOAD)?.driver).toMatchObject({ open: false, readable: false, unread: 0 });
    expect(summaries.get(LOAD)?.driver.note).toMatch(/once a driver accepts/);
    expect(mockMessageAggregate).not.toHaveBeenCalled();
  });
});
