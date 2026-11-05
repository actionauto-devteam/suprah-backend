/**
 * "Confirm received" and the customer's one review of a delivered shipment:
 * only the customer who follows it, only once it's delivered, one review per
 * load that can't be changed, the words only for the load's own dealership,
 * the driver's star average for Driver Tracker. Models are stand-ins; no
 * database is used.
 */
const chain = (value: () => unknown) => {
  const self: any = {
    select: () => self,
    sort: () => self,
    populate: () => self,
    lean: () => Promise.resolve(value()),
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(value()).then(resolve, reject),
  };
  return self;
};

const mockQuoteFindById = jest.fn();
const mockLoadFindOne = jest.fn();
const mockReviewFindOne = jest.fn();
const mockReviewCreate = jest.fn();
const mockReviewUpdate = jest.fn();
const mockReviewFind = jest.fn();
const mockReviewAggregate = jest.fn();
const mockFollower = jest.fn();
const mockDispatchers = jest.fn();
const mockEmit = jest.fn();
const mockNotify = jest.fn();

jest.mock('../../src/models/Quote.model', () => ({ __esModule: true, default: { findById: (id: unknown) => chain(() => mockQuoteFindById(id)) } }));
jest.mock('../../src/models/Load.model', () => ({ __esModule: true, default: { findOne: (f: unknown) => chain(() => mockLoadFindOne(f)) } }));
jest.mock('../../src/models/ShipmentReview.model', () => ({
  __esModule: true,
  default: {
    findOne: (f: unknown) => chain(() => mockReviewFindOne(f)),
    create: (doc: unknown) => mockReviewCreate(doc),
    findOneAndUpdate: (...args: unknown[]) => chain(() => mockReviewUpdate(...args)),
    find: (f: unknown) => chain(() => mockReviewFind(f)),
    aggregate: (p: unknown) => mockReviewAggregate(p),
  },
}));
jest.mock('../../src/services/shipmentFollower', () => ({ __esModule: true, findQuoteFollower: (q: unknown) => mockFollower(q) }));
jest.mock('../../src/services/shipmentChat.service', () => ({
  __esModule: true,
  LOAD_CHAT_NOT_FOUND: "We couldn't find this load. Refresh the page and try again.",
  loadDispatchers: (loads: unknown[]) => mockDispatchers(loads),
}));
jest.mock('../../src/services/customerShipmentTracking', () => ({
  __esModule: true,
  SHIPMENT_NOT_FOUND: "We couldn't find this shipment in your account. Refresh My Shipments and try again.",
}));
jest.mock('../../src/utils/socketEmitter', () => ({ __esModule: true, emitToUser: (...args: unknown[]) => mockEmit(...args) }));
jest.mock('../../src/utils/safeNotification', () => ({ __esModule: true, safeCreateNotification: (p: unknown) => mockNotify(p) }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import {
  confirmShipmentReceived,
  driverCustomerRatings,
  loadCustomerReview,
  parseReview,
  receiptsForLoads,
  reviewShipment,
} from '../../src/services/shipmentReview.service';

const ORG = '64b0000000000000000000a1';
const OTHER_ORG = '64b0000000000000000000a2';
const QUOTE = '64b0000000000000000000e1';
const LOAD = '64b0000000000000000000b1';
const CUSTOMER = '64b0000000000000000000c9';
const DRIVER = '64b0000000000000000000d1';
const DISPATCHER = '64b0000000000000000000f1';

const delivered = () => ({
  _id: LOAD, organizationId: ORG, quoteId: QUOTE, loadNumber: 'L-1001', status: 'Delivered', assignedDriverId: DRIVER, deliveredAt: new Date(),
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  mockQuoteFindById.mockReturnValue({ _id: QUOTE, organizationId: ORG, source: 'customer_portal', requestedBy: CUSTOMER, vehicleName: '2021 Toyota Camry' });
  mockFollower.mockResolvedValue({ id: CUSTOMER, name: 'Maria', email: 'maria@example.com', kind: 'request' });
  mockLoadFindOne.mockImplementation(() => delivered());
  mockReviewFindOne.mockReturnValue(null);
  mockReviewCreate.mockImplementation((doc: any) => Promise.resolve({ ...doc }));
  mockReviewUpdate.mockImplementation((_f: unknown, update: any) => ({ receivedAt: new Date('2026-11-05T18:00:00Z'), ...update.$set }));
  mockReviewFind.mockReturnValue([]);
  mockReviewAggregate.mockResolvedValue([]);
  mockDispatchers.mockResolvedValue(new Map([[LOAD, { id: DISPATCHER, name: 'Dana Dispatch' }]]));
  mockNotify.mockResolvedValue({});
});

describe('checking a review', () => {
  it('takes 1 to 5 whole stars for the driver and optional words', () => {
    expect(parseReview({ driverStars: 5, driverComment: '  Careful and on time  ' }, true)).toEqual({
      driverStars: 5, driverComment: 'Careful and on time', dealershipComment: '',
    });
    expect(parseReview({ dealershipComment: 'Smooth from start to finish' }, true)).toEqual({
      driverStars: null, driverComment: '', dealershipComment: 'Smooth from start to finish',
    });
    for (const stars of [0, 6, 3.5, 'five']) {
      expect(() => parseReview({ driverStars: stars }, true)).toThrow('Choose 1 to 5 stars for your driver.');
    }
  });

  it('asks for stars before words about the driver, and for something to send', () => {
    expect(() => parseReview({ driverComment: 'Great' }, true)).toThrow(/Choose 1 to 5 stars for your driver, then send/);
    expect(() => parseReview({}, true)).toThrow(/Choose stars for your driver or write a few words for the dealership/);
    expect(() => parseReview({ driverComment: 'x'.repeat(1001), driverStars: 4 }, true)).toThrow(/up to 1,000 characters/);
    expect(() => parseReview({ dealershipComment: 'x'.repeat(2001) }, true)).toThrow(/up to 2,000 characters/);
  });

  it("ignores driver stars when nobody drove the load (staff marked it delivered)", () => {
    expect(() => parseReview({ driverStars: 5 }, false)).toThrow('Write a few words for the dealership, then send your review.');
    expect(parseReview({ driverStars: 5, dealershipComment: 'Thanks' }, false)).toMatchObject({ driverStars: null, dealershipComment: 'Thanks' });
  });
});

describe('confirm received', () => {
  it("only the customer who follows the shipment, and only once it's delivered", async () => {
    mockFollower.mockResolvedValueOnce({ id: 'someone-else', kind: 'shared' });
    await expect(confirmShipmentReceived(CUSTOMER, QUOTE, {})).rejects.toMatchObject({ statusCode: 404 });
    mockLoadFindOne.mockReturnValueOnce({ ...delivered(), status: 'In-Transit' });
    await expect(confirmShipmentReceived(CUSTOMER, QUOTE, {})).rejects.toMatchObject({
      statusCode: 409, message: expect.stringMatching(/You can confirm once your vehicle is delivered/),
    });
    expect(mockLoadFindOne).toHaveBeenCalledWith({ quoteId: QUOTE, organizationId: ORG });
    expect(mockReviewCreate).not.toHaveBeenCalled();
  });

  it('records it, closes both chats on open screens, and tells the dispatcher', async () => {
    const result = await confirmShipmentReceived(CUSTOMER, QUOTE, {});
    await flush();
    expect(result).toMatchObject({ alreadyConfirmed: false, receipt: { reviewed: false, driverStars: null } });
    expect(mockReviewCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, loadId: LOAD, quoteId: QUOTE, driverId: DRIVER, receivedAt: expect.any(Date) }));
    const changed = mockEmit.mock.calls.filter(([, event]) => event === 'shipment-chat:changed').map(([userId, , p]) => `${userId}:${p.kind}`);
    expect(changed.sort()).toEqual([`${CUSTOMER}:dispatcher`, `${CUSTOMER}:driver`, `${DISPATCHER}:dispatcher`, `${DISPATCHER}:driver`, `${DRIVER}:dispatcher`, `${DRIVER}:driver`].sort());
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      userId: DISPATCHER,
      type: 'shipment_status_changed',
      title: 'Vehicle received',
      message: 'Maria confirmed they received the 2021 Toyota Camry (load L-1001). Their chats on this load are now closed.',
      metadata: expect.objectContaining({ route: `/transportation/load/${LOAD}` }),
    }));
  });

  it('confirming twice is harmless', async () => {
    mockReviewFindOne.mockReturnValueOnce({ receivedAt: new Date('2026-11-05T18:00:00Z'), reviewedAt: null });
    const result = await confirmShipmentReceived(CUSTOMER, QUOTE, {});
    expect(result).toMatchObject({ alreadyConfirmed: true, receipt: { receivedAt: '2026-11-05T18:00:00.000Z' } });
    expect(mockReviewCreate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('two screens confirming at once count once', async () => {
    mockReviewCreate.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 11000 }));
    mockReviewFindOne.mockReturnValueOnce(null).mockReturnValueOnce({ receivedAt: new Date(), reviewedAt: null });
    expect(await confirmShipmentReceived(CUSTOMER, QUOTE, {})).toMatchObject({ alreadyConfirmed: true });
  });

  it('can carry the review in the same step', async () => {
    const result = await confirmShipmentReceived(CUSTOMER, QUOTE, { driverStars: 4, dealershipComment: 'Thank you' });
    await flush();
    expect(result.receipt).toMatchObject({ reviewed: true, driverStars: 4 });
    expect(mockReviewCreate).toHaveBeenCalledWith(expect.objectContaining({ driverStars: 4, dealershipComment: 'Thank you', reviewedAt: expect.any(Date) }));
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ title: 'New customer review' }));
  });
});

describe('the review', () => {
  it('is added once to an earlier confirmation and never changed', async () => {
    mockReviewFindOne.mockReturnValueOnce({ receivedAt: new Date(), reviewedAt: null });
    const result = await reviewShipment(CUSTOMER, QUOTE, { driverStars: 5, driverComment: 'Great driver' });
    expect(result.receipt).toMatchObject({ reviewed: true, driverStars: 5 });
    expect(mockReviewUpdate).toHaveBeenCalledWith({ loadId: LOAD, reviewedAt: null }, { $set: expect.objectContaining({ driverStars: 5, driverComment: 'Great driver' }) }, { new: true });

    mockReviewFindOne.mockReturnValueOnce({ receivedAt: new Date(), reviewedAt: new Date() });
    await expect(reviewShipment(CUSTOMER, QUOTE, { driverStars: 1 })).rejects.toMatchObject({
      statusCode: 409, message: "You've already reviewed this delivery. Reviews can't be changed once they're sent.",
    });
  });

  it('a second review sent at the same moment is refused', async () => {
    mockReviewFindOne.mockReturnValueOnce({ receivedAt: new Date(), reviewedAt: null });
    mockReviewUpdate.mockReturnValueOnce(null);
    await expect(reviewShipment(CUSTOMER, QUOTE, { driverStars: 3 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('confirms receipt too when sent first', async () => {
    const result = await reviewShipment(CUSTOMER, QUOTE, { dealershipComment: 'All good' });
    expect(result.receipt.reviewed).toBe(true);
    expect(mockReviewCreate).toHaveBeenCalledWith(expect.objectContaining({ receivedAt: expect.any(Date), dealershipComment: 'All good' }));
  });
});

describe('who sees reviews', () => {
  it("only the load's own dealership staff, never drivers", async () => {
    await expect(loadCustomerReview({ role: 'driver' }, ORG, LOAD)).rejects.toMatchObject({ statusCode: 403 });
    mockLoadFindOne.mockReturnValueOnce(null);
    await expect(loadCustomerReview({ role: 'employee' }, OTHER_ORG, LOAD)).rejects.toMatchObject({ statusCode: 404 });
    expect(mockLoadFindOne).toHaveBeenLastCalledWith({ _id: LOAD, organizationId: OTHER_ORG });

    mockReviewFindOne.mockReturnValueOnce({
      customerId: { name: 'Maria' }, receivedAt: new Date('2026-11-05T18:00:00Z'), reviewedAt: new Date('2026-11-05T18:05:00Z'),
      driverStars: 4, driverComment: 'Friendly', dealershipComment: 'Fast quote',
    });
    expect(await loadCustomerReview({ role: 'employee' }, ORG, LOAD)).toEqual({
      customerName: 'Maria', receivedAt: '2026-11-05T18:00:00.000Z', reviewedAt: '2026-11-05T18:05:00.000Z',
      driverStars: 4, driverComment: 'Friendly', dealershipComment: 'Fast quote',
    });
    expect(mockReviewFindOne).toHaveBeenLastCalledWith({ loadId: LOAD, organizationId: ORG });
  });

  it("gives Driver Tracker each driver's star average, rounded, and only from rated deliveries", async () => {
    mockReviewAggregate.mockResolvedValueOnce([{ _id: DRIVER, average: 4.666, count: 3 }]);
    const ratings = await driverCustomerRatings([DRIVER, DRIVER, 'bad-id']);
    expect(ratings.get(DRIVER)).toEqual({ average: 4.7, count: 3 });
    const [pipeline] = mockReviewAggregate.mock.calls[0];
    expect(pipeline[0].$match.driverStars).toEqual({ $gte: 1 });
    expect(pipeline[0].$match.driverId.$in.map(String)).toEqual([DRIVER]);
    expect(await driverCustomerRatings([])).toEqual(new Map());
  });

  it('tells My Shipments what the customer already did', async () => {
    mockReviewFind.mockReturnValueOnce([{ loadId: LOAD, receivedAt: new Date('2026-11-05T18:00:00Z'), reviewedAt: null, driverStars: null }]);
    const receipts = await receiptsForLoads([LOAD]);
    expect(receipts.get(LOAD)).toEqual({ receivedAt: '2026-11-05T18:00:00.000Z', reviewed: false, driverStars: null });
  });
});
