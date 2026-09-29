jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: jest.fn() } },
  }));
});

process.env.GEMINI_API_KEY = 'test-key';

const mockLeadFind = jest.fn();
const mockLogCreate = jest.fn();
const mockSendPriceDropEmail = jest.fn();

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { find: mockLeadFind },
}));

jest.mock('../../src/models/PriceDropEmailLog.model', () => ({
  __esModule: true,
  default: { create: mockLogCreate },
}));

jest.mock('../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendPriceDropEmail: mockSendPriceDropEmail },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

import { processVehicleForPriceDrop, matchLeadsForVehicle } from '../../src/services/priceDropEmail.service';

function seedLeads(leads: any[]) {
  const lean = jest.fn().mockResolvedValue(leads);
  const limit = jest.fn(() => ({ lean }));
  const select = jest.fn(() => ({ limit }));
  mockLeadFind.mockReturnValue({ select });
}

function baseVehicle(overrides: any = {}) {
  return {
    _id: 'vehicle-1',
    organizationId: 'org-1',
    year: 2022,
    make: 'Toyota',
    modelName: 'Camry',
    trim: 'SE',
    vin: 'VIN123',
    stockNumber: 'STK1',
    priceHistory: [{ previousPrice: 25000, newPrice: 24000, changedAt: new Date('2026-09-29') }],
    ...overrides,
  };
}

describe('matchLeadsForVehicle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('matches by exact VIN even if year/make/model differ', async () => {
    seedLeads([
      { _id: 'lead-1', email: 'a@test.com', vehicle: { vin: 'VIN123', year: '2020', make: 'Honda', model: 'Civic' } },
    ]);
    const result = await matchLeadsForVehicle(baseVehicle() as any);
    expect(result).toEqual([{ lead: expect.objectContaining({ _id: 'lead-1' }), matchMethod: 'vin' }]);
  });

  it('matches by exact stock number when vin does not match', async () => {
    seedLeads([
      { _id: 'lead-2', email: 'b@test.com', vehicle: { stock: 'STK1', year: '2020', make: 'Honda', model: 'Civic' } },
    ]);
    const result = await matchLeadsForVehicle(baseVehicle() as any);
    expect(result).toEqual([{ lead: expect.objectContaining({ _id: 'lead-2' }), matchMethod: 'stock' }]);
  });

  it('falls back to fuzzy year/make/model matching only when the lead has no vin/stock', async () => {
    seedLeads([{ _id: 'lead-3', email: 'c@test.com', vehicle: { year: '2022', make: 'Toyota', model: 'Camry' } }]);
    const result = await matchLeadsForVehicle(baseVehicle() as any);
    expect(result).toEqual([{ lead: expect.objectContaining({ _id: 'lead-3' }), matchMethod: 'fuzzy' }]);
  });

  it('does not fuzzy-match a lead whose own vin/stock is known but different', async () => {
    seedLeads([
      { _id: 'lead-4', email: 'd@test.com', vehicle: { vin: 'OTHERVIN', year: '2022', make: 'Toyota', model: 'Camry' } },
    ]);
    const result = await matchLeadsForVehicle(baseVehicle() as any);
    expect(result).toEqual([]);
  });
});

describe('processVehicleForPriceDrop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLogCreate.mockResolvedValue({});
  });

  it('skips vehicles with no price history', async () => {
    const result = await processVehicleForPriceDrop(baseVehicle({ priceHistory: [] }) as any);
    expect(result).toEqual({ matched: 0 });
    expect(mockLeadFind).not.toHaveBeenCalled();
  });

  it('skips a drop smaller than the minimum threshold', async () => {
    const result = await processVehicleForPriceDrop(
      baseVehicle({ priceHistory: [{ previousPrice: 25000, newPrice: 24900, changedAt: new Date() }] }) as any,
    );
    expect(result).toEqual({ matched: 0 });
  });

  it('skips a price increase', async () => {
    const result = await processVehicleForPriceDrop(
      baseVehicle({ priceHistory: [{ previousPrice: 20000, newPrice: 24000, changedAt: new Date() }] }) as any,
    );
    expect(result).toEqual({ matched: 0 });
  });

  it('sends an email and logs "sent" for each matched lead', async () => {
    seedLeads([{ _id: 'lead-1', email: 'a@test.com', vehicle: { vin: 'VIN123' } }]);
    mockSendPriceDropEmail.mockResolvedValue(true);

    const result = await processVehicleForPriceDrop(baseVehicle() as any);

    expect(result).toEqual({ matched: 1 });
    expect(mockSendPriceDropEmail).toHaveBeenCalledTimes(1);
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'sent', leadId: 'lead-1' }));
  });

  it('logs "skipped" when the email service reports no send (opted out / no email)', async () => {
    seedLeads([{ _id: 'lead-1', email: 'a@test.com', vehicle: { vin: 'VIN123' } }]);
    mockSendPriceDropEmail.mockResolvedValue(false);

    await processVehicleForPriceDrop(baseVehicle() as any);

    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }));
  });

  it('logs "failed" when the email service throws', async () => {
    seedLeads([{ _id: 'lead-1', email: 'a@test.com', vehicle: { vin: 'VIN123' } }]);
    mockSendPriceDropEmail.mockRejectedValue(new Error('smtp down'));

    await processVehicleForPriceDrop(baseVehicle() as any);

    expect(mockLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failureReason: 'smtp down' }),
    );
  });

  it('does not throw when the log write hits the dedup unique-index collision', async () => {
    seedLeads([{ _id: 'lead-1', email: 'a@test.com', vehicle: { vin: 'VIN123' } }]);
    mockSendPriceDropEmail.mockResolvedValue(true);
    const dupError: any = new Error('E11000 duplicate key');
    dupError.code = 11000;
    mockLogCreate.mockRejectedValueOnce(dupError);

    await expect(processVehicleForPriceDrop(baseVehicle() as any)).resolves.toEqual({ matched: 1 });
  });
});
