/**
 * Converting a quote tells staff about other live loads for the same car so
 * they can check the new load isn't a duplicate. It never stops the
 * conversion. Models are stand-ins; no database is used.
 */
const mockQuoteFindOne = jest.fn();
const mockLoadFindOne = jest.fn();
const mockLoadCreate = jest.fn();
const mockFindVehicleShipping = jest.fn();

jest.mock('../../src/models/Quote.model', () => ({
  __esModule: true,
  default: { findOne: (filter: unknown) => Promise.resolve(mockQuoteFindOne(filter)) },
}));
jest.mock('../../src/models/Load.model', () => ({
  __esModule: true,
  default: {
    findOne: (filter: unknown) => Promise.resolve(mockLoadFindOne(filter)),
    create: (doc: unknown) => Promise.resolve(mockLoadCreate(doc)),
  },
}));
jest.mock('../../src/services/vehicleShipping.service', () => ({
  findVehicleShipping: (...args: unknown[]) => mockFindVehicleShipping(...args),
}));
jest.mock('../../src/services/quoteLeadLink.service', () => ({ findQuoteLeadLink: jest.fn(() => Promise.resolve(null)) }));
jest.mock('../../src/services/customerShipments.service', () => ({
  notifyQuoteCustomer: jest.fn(),
  notifyCustomerOfDeletedRequest: jest.fn(),
  listCustomerShipments: jest.fn(),
}));
jest.mock('../../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn(() => Promise.resolve()),
  safeCreateNotification: jest.fn(),
}));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/services/cache.service', () => ({ __esModule: true, default: { invalidateByPrefix: jest.fn() } }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => null }));

import quoteController from '../../src/controllers/quote.controller';

const QUOTE_ID = '64b0000000000000000000d1';
const CAR = '64b0000000000000000000b1';

function convert() {
  return new Promise<{ status: number; body?: any; error?: any }>((resolve) => {
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: any) { resolve({ status: this.statusCode, body }); return this; },
    };
    const req: any = { body: {}, params: { id: QUOTE_ID }, orgId: 'org-1', user: { _id: 'staff-1' }, auth: { userId: 'staff-1' }, ip: '127.0.0.1', get: () => 'jest' };
    quoteController.convertToLoad(req, res, (error: any) => resolve({ status: error?.statusCode, error }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuoteFindOne.mockReturnValue({
    _id: QUOTE_ID,
    firstName: 'Maria',
    lastName: 'Santos',
    email: 'maria@example.com',
    phone: '8015550100',
    status: 'accepted',
    leadId: 'lead-1',
    vehicleId: CAR,
    vin: '1HGCM82633A123456',
    fromAddress: '1 Main St, Orem, UT',
    fromZip: '84057',
    toAddress: '20 Oak Ave, Denver, CO',
    toZip: '80202',
    vehicleName: '2021 Toyota Camry',
    rate: 950,
    miles: 520,
    save: jest.fn(),
  });
  mockLoadFindOne.mockReturnValue(null);
  mockLoadCreate.mockImplementation((doc: any) => ({
    _id: 'load-new',
    loadNumber: 'LD-9',
    toJSON() { return { _id: 'load-new', loadNumber: 'LD-9', status: doc.status }; },
  }));
});

describe('converting a quote whose car is already on a load', () => {
  it('returns the other live loads for the same car, leaving out the new one', async () => {
    mockFindVehicleShipping.mockResolvedValue({
      loads: [{ _id: 'load-old', loadNumber: 'LD-3', status: 'Posted', vehicleIds: [CAR], vins: [] }],
      quotes: [],
    });
    const { status, body } = await convert();
    expect(status).toBe(201);
    expect(body.data).toMatchObject({ _id: 'load-new', loadNumber: 'LD-9', status: 'Draft' });
    expect(body.data.sameVehicleLoads).toEqual([{ _id: 'load-old', loadNumber: 'LD-3', status: 'Posted' }]);
    expect(mockFindVehicleShipping).toHaveBeenCalledWith(
      'org-1',
      { vehicleIds: [CAR], vins: ['1HGCM82633A123456'] },
      { excludeLoadId: 'load-new' },
    );
  });

  it('still converts when the check fails', async () => {
    mockFindVehicleShipping.mockRejectedValue(new Error('down'));
    const { status, body } = await convert();
    expect(status).toBe(201);
    expect(body.data.sameVehicleLoads).toEqual([]);
  });
});
