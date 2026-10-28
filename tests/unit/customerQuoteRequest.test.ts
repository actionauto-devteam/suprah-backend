/**
 * Customer portal shipping requests: the quote goes to the dealership that
 * owns the vehicle, picks up from that dealership's lot, and uses the
 * customer's own account details. Models are stand-ins; no database is used.
 */
const mockVehicleFindOne = jest.fn();
const mockQuoteFindOne = jest.fn();
const mockQuoteCreate = jest.fn();
const mockNotifyOrgAdmins = jest.fn();

jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: { findOne: (...args: unknown[]) => ({ lean: () => Promise.resolve(mockVehicleFindOne(...args)) }) },
}));
jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: {
    findOne: (...args: unknown[]) => ({ lean: () => Promise.resolve(mockQuoteFindOne(...args)) }),
    create: (...args: unknown[]) => mockQuoteCreate(...args),
  },
}));
jest.mock('../../src/utils/calculations', () => ({
  getCoordinatesFromZip: jest.fn(async (zip: string) => ({ lat: 40, lon: zip === '84058' ? -111.7 : -104.9 })),
  calculateDistance: jest.fn(() => 500),
  calculateRate: jest.fn(() => 950),
  calculateETA: jest.fn(() => ({ min: 2, max: 4 })),
  getCoordinatesForPair: jest.fn(),
}));
jest.mock('../../src/utils/safeNotification', () => ({
  notifyOrgAdmins: (...args: unknown[]) => mockNotifyOrgAdmins(...args),
  safeCreateNotification: jest.fn(),
}));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { invalidateByPrefix: jest.fn() } }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null }));
const mockFindQuoteLeadLink = jest.fn();
jest.mock('../../src/services/quoteLeadLink.service', () => ({
  findQuoteLeadLink: (...args: unknown[]) => mockFindQuoteLeadLink(...args),
}));

import quoteController from '../../src/controllers/quote.controller';

const VEHICLE_ID = '64b000000000000000000001';
const CUSTOMER_ID = '64b0000000000000000000c1';

const marketplaceVehicle = {
  _id: VEHICLE_ID,
  organizationId: 'dealership-that-owns-the-car',
  year: 2021,
  make: 'Toyota',
  modelName: 'Camry',
  vin: '4T1BF1FK0CU000001',
  stockNumber: 'A100',
  price: 21000,
  status: 'Ready for Sale',
  dealerName: 'Action Auto',
  dealerAddress: '100 State St',
  dealerCity: 'Orem',
  dealerState: 'UT',
  dealerZip: '84058',
  images: ['https://example.com/camry.jpg'],
};

const customer = {
  _id: CUSTOMER_ID,
  role: 'customer',
  name: 'Maria Santos',
  email: 'maria@example.com',
  personalInfo: { phone: '801-555-0100' },
};

const formBody = {
  vehicleId: VEHICLE_ID,
  // Typed into the form; the account details must win.
  firstName: 'Someone',
  lastName: 'Else',
  email: 'someone-else@example.com',
  phone: '000',
  // A pickup the customer can't know; the dealership's lot must win.
  fromZip: '10001',
  fromAddress: 'New York, NY',
  toCity: 'Denver',
  toState: 'CO',
  toStreetAddress: '5 Main St',
  zipCode: '80202',
  toZip: '80202',
};

/** Runs the handler and resolves with the response, or the error passed to next(). */
function send(body: Record<string, unknown>, user: Record<string, unknown> = customer) {
  return new Promise<{ status: number; body: any; error?: any }>((resolve) => {
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: unknown) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    const req: any = { body, user, ip: '127.0.0.1', get: () => 'jest' };
    quoteController.createCustomerQuoteRequest(req, res, (error: any) => resolve({ status: error?.statusCode, body: null, error }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVehicleFindOne.mockReturnValue(marketplaceVehicle);
  mockQuoteFindOne.mockReturnValue(null);
  mockQuoteCreate.mockImplementation(async (doc: any) => ({ _id: 'new-quote-id', ...doc }));
  mockFindQuoteLeadLink.mockResolvedValue(null);
});

describe('POST /api/quote-requests', () => {
  it("sends the request to the dealership that owns the vehicle, marked as from the customer portal", async () => {
    const result = await send(formBody);
    expect(result.status).toBe(201);
    const saved = mockQuoteCreate.mock.calls[0][0];
    expect(saved.organizationId).toBe('dealership-that-owns-the-car');
    expect(saved.source).toBe('customer_portal');
    expect(String(saved.requestedBy)).toBe(CUSTOMER_ID);
    expect(saved.createdBy).toBeUndefined();
    expect(saved.status).toBe('pending');
  });

  it("uses the customer's own account details, not what was typed into the form", async () => {
    await send(formBody);
    const saved = mockQuoteCreate.mock.calls[0][0];
    expect(saved).toMatchObject({ firstName: 'Maria', lastName: 'Santos', email: 'maria@example.com', phone: '801-555-0100' });
  });

  it("picks up from the dealership's lot and delivers where the customer asked", async () => {
    await send(formBody);
    const saved = mockQuoteCreate.mock.calls[0][0];
    expect(saved.fromZip).toBe('84058');
    expect(saved.fromAddress).toBe('100 State St, Orem, UT');
    expect(saved.toZip).toBe('80202');
    expect(saved.toAddress).toBe('5 Main St, Denver, CO');
    expect(saved.rate).toBe(950);
  });

  it('only shows the customer their own request, without dealership details', async () => {
    const result = await send(formBody);
    expect(result.body.data).toEqual({
      id: 'new-quote-id',
      vehicleName: '2021 Toyota Camry',
      toAddress: '5 Main St, Denver, CO',
      miles: 500,
      rate: 950,
      eta: { min: 2, max: 4 },
      status: 'pending',
    });
    expect(result.body.message).toBe('Your shipping quote request was sent to the dealership.');
  });

  it("tells the dealership's admins about the new request", async () => {
    await send(formBody);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockNotifyOrgAdmins).toHaveBeenCalledWith(
      'dealership-that-owns-the-car',
      'quote_created',
      'New Shipping Request',
      'Maria Santos asked for a shipping quote for 2021 Toyota Camry to Denver, CO.',
      expect.objectContaining({ source: 'customer_portal' }),
    );
  });

  it('returns the earlier request instead of creating a duplicate', async () => {
    mockQuoteFindOne.mockReturnValue({ _id: 'earlier-id', vehicleName: '2021 Toyota Camry', toAddress: '5 Main St, Denver, CO', miles: 500, rate: 950, eta: { min: 2, max: 4 }, status: 'pending' });
    const result = await send(formBody);
    expect(result.status).toBe(200);
    expect(result.body.data.id).toBe('earlier-id');
    expect(result.body.message).toBe('You already asked for this shipping quote. The dealership has your request.');
    expect(mockQuoteCreate).not.toHaveBeenCalled();
  });

  it("links the request to the dealership's CRM lead for this customer, without showing it to the customer", async () => {
    mockFindQuoteLeadLink.mockResolvedValue({ leadId: 'lead-1', customerRecordId: 'customer-1' });
    const result = await send(formBody);
    expect(mockFindQuoteLeadLink).toHaveBeenCalledWith('dealership-that-owns-the-car', { email: 'maria@example.com', phone: '801-555-0100' });
    expect(mockQuoteCreate.mock.calls[0][0]).toMatchObject({ leadId: 'lead-1', customerRecordId: 'customer-1' });
    expect(result.body.data.leadId).toBeUndefined();
  });

  it('still saves the request when the lead lookup fails', async () => {
    mockFindQuoteLeadLink.mockRejectedValue(new Error('lookup failed'));
    const result = await send(formBody);
    expect(result.status).toBe(201);
    expect(mockQuoteCreate.mock.calls[0][0].leadId).toBeUndefined();
  });

  it('treats any still-pending request for the same car and destination as the same request', async () => {
    await send(formBody);
    expect(mockQuoteFindOne.mock.calls[0][0]).toEqual({
      source: 'customer_portal',
      requestedBy: CUSTOMER_ID,
      vehicleId: VEHICLE_ID,
      toZip: '80202',
      status: 'pending',
    });
  });

  it('when two devices send the same request at the same moment, the second gets the first one back', async () => {
    const winner = { _id: 'winner-id', vehicleName: '2021 Toyota Camry', toAddress: '5 Main St, Denver, CO', miles: 500, rate: 950, eta: { min: 2, max: 4 }, status: 'pending' };
    mockQuoteFindOne.mockReturnValueOnce(null).mockReturnValueOnce(winner);
    mockQuoteCreate.mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }));
    const result = await send(formBody);
    expect(result.status).toBe(200);
    expect(result.body.data.id).toBe('winner-id');
    expect(result.body.message).toBe('You already asked for this shipping quote. The dealership has your request.');
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('still reports other save failures instead of hiding them', async () => {
    mockQuoteCreate.mockRejectedValueOnce(new Error('database unavailable'));
    const result = await send(formBody);
    expect(result.error.message).toBe('database unavailable');
  });

  it("refuses a vehicle that isn't on the marketplace any more", async () => {
    mockVehicleFindOne.mockReturnValue(null);
    const result = await send(formBody);
    expect(result.status).toBe(404);
    expect(result.error.message).toBe("This vehicle is no longer available, so we can't quote shipping for it. Refresh the page and choose another vehicle.");
    const filter = mockVehicleFindOne.mock.calls[0][0];
    expect(filter).toMatchObject({ isDeleted: false, status: 'Ready for Sale' });
  });

  it('asks for a phone number when the account has none and the form left it empty', async () => {
    const result = await send({ ...formBody, phone: '' }, { ...customer, personalInfo: {} });
    expect(result.status).toBe(400);
    expect(result.error.message).toBe(
      'Enter your phone number with the area code, for example (801) 555-0123, so the dealership can reach you about shipping.',
    );
  });

  it("refuses a typed phone number that can't be one, and uses a typed one when the account's isn't usable", async () => {
    for (const phone of ['000', 'call me', '1'.repeat(16), `801-555-0100 ${'x'.repeat(30)}`]) {
      const result = await send({ ...formBody, phone }, { ...customer, personalInfo: {} });
      expect(result.status).toBe(400);
    }
    expect(mockQuoteCreate).not.toHaveBeenCalled();

    const result = await send({ ...formBody, phone: '(385) 555-0199' }, { ...customer, personalInfo: { phone: '555' } });
    expect(result.status).toBe(201);
    expect(mockQuoteCreate.mock.calls[0][0].phone).toBe('(385) 555-0199');
  });

  it('refuses typed text that is too long for a quote card, saying which field', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ lastName: 'x'.repeat(81) }, 'Keep the last name under 80 characters, then send your request again.'],
      [{ toStreetAddress: 'x'.repeat(201) }, 'Keep the delivery street address under 200 characters, then send your request again.'],
      [{ fullAddress: 'x'.repeat(301) }, 'Keep the delivery address under 300 characters, then send your request again.'],
    ];
    for (const [extra, message] of cases) {
      const result = await send({ ...formBody, ...extra });
      expect(result.status).toBe(400);
      expect(result.error.message).toBe(message);
    }
    expect(mockQuoteCreate).not.toHaveBeenCalled();
    expect((await send({ ...formBody, toStreetAddress: 'x'.repeat(200) })).status).toBe(201);
  });

  it('asks for a vehicle when none was chosen', async () => {
    const result = await send({ ...formBody, vehicleId: 'not-an-id' });
    expect(result.status).toBe(400);
    expect(result.error.message).toBe('Choose a vehicle to get a shipping quote for.');
  });
});
