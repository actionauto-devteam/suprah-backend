const mockLeadFind = jest.fn();
const mockSmsRecipientAggregate = jest.fn();
const mockEmailRecipientAggregate = jest.fn();
const mockPriceDropAggregate = jest.fn();
const mockReengagementAggregate = jest.fn();
const mockSmsOptOutCount = jest.fn();
const mockEmailOptOutCount = jest.fn();

jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: { find: mockLeadFind } }));
jest.mock('../../src/models/SmsCampaignRecipient.model', () => ({ __esModule: true, default: { aggregate: mockSmsRecipientAggregate } }));
jest.mock('../../src/models/EmailCampaignRecipient.model', () => ({ __esModule: true, default: { aggregate: mockEmailRecipientAggregate } }));
jest.mock('../../src/models/PriceDropEmailLog.model', () => ({ __esModule: true, default: { aggregate: mockPriceDropAggregate } }));
jest.mock('../../src/models/VehicleReengagementLog.model', () => ({ __esModule: true, default: { aggregate: mockReengagementAggregate } }));
jest.mock('../../src/models/SmsOptOut.model', () => ({ __esModule: true, default: { countDocuments: mockSmsOptOutCount } }));
jest.mock('../../src/models/EmailOptOut.model', () => ({ __esModule: true, default: { countDocuments: mockEmailOptOutCount } }));

import { getCrmReportsOverview } from '../../src/controllers/crmReports.controller';

function selectLean(value: unknown) {
  return { select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(value) })) };
}

describe('crmReports.controller — getCrmReportsOverview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLeadFind.mockReturnValue(selectLean([]));
    mockSmsRecipientAggregate.mockResolvedValue([]);
    mockEmailRecipientAggregate.mockResolvedValue([]);
    mockPriceDropAggregate.mockResolvedValue([]);
    mockReengagementAggregate.mockResolvedValue([]);
    mockSmsOptOutCount.mockResolvedValue(0);
    mockEmailOptOutCount.mockResolvedValue(0);
  });

  it('rejects a request missing from/to with a 400 ApiError', async () => {
    const req = { query: {}, orgId: 'org-1' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCrmReportsOverview(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toEqual(expect.objectContaining({ statusCode: 400 }));
    expect(json).not.toHaveBeenCalled();
  });

  it('scopes every query to the requesting org and the given date range', async () => {
    const req = { query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z' }, orgId: '507f1f77bcf86cd799439011' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCrmReportsOverview(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    const leadMatch = mockLeadFind.mock.calls[0][0];
    expect(String(leadMatch.organizationId)).toBe('507f1f77bcf86cd799439011');
    expect(leadMatch.createdAt.$gte.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(leadMatch.createdAt.$lte.toISOString()).toBe('2026-10-07T23:59:59.999Z');

    const smsPipeline = mockSmsRecipientAggregate.mock.calls[0][0];
    expect(smsPipeline[0].$match.organizationId).toBe('507f1f77bcf86cd799439011');
    expect(mockSmsOptOutCount).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '507f1f77bcf86cd799439011', optedOut: true }));
  });

  it('excludes genuine Demo Lab leads (source "Demo" + a fictional phone) from lead counts, but keeps a real lead whose source was manually typed as "Demo"', async () => {
    mockLeadFind.mockReturnValue(selectLean([
      { status: 'New', source: 'Demo', channel: 'sms', phone: '+18015550101' },
      { status: 'New', source: 'Demo', channel: 'sms', phone: '+13035551234' },
      { status: 'Contacted', source: 'Website Chat', channel: 'webchat', phone: '+13035555555' },
    ]));

    const req = { query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z' }, orgId: '507f1f77bcf86cd799439011' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCrmReportsOverview(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    const response = json.mock.calls[0][0];
    expect(response.data.leads.total).toBe(2);
    expect(response.data.leads.byStatus).toEqual({ New: 1, Contacted: 1 });
  });

  it('normalizes lead source labels the same way the Lead Source Report does', async () => {
    mockLeadFind.mockReturnValue(selectLean([
      { status: 'New', source: 'Gmail Sync', channel: 'email', phone: '' },
      { status: 'New', source: 'AutoTrader', channel: 'adf', phone: '' },
    ]));

    const req = { query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z' }, orgId: '507f1f77bcf86cd799439011' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCrmReportsOverview(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    const response = json.mock.calls[0][0];
    expect(response.data.leads.bySource).toEqual({ 'Email Inquiry': 1, 'Third-Party Lead': 1 });
  });

  it('maps aggregate rows into per-status count objects for campaigns, price drop, and re-engagement', async () => {
    mockSmsRecipientAggregate.mockResolvedValue([{ _id: 'sent', count: 5 }, { _id: 'failed', count: 1 }]);
    mockEmailRecipientAggregate.mockResolvedValue([{ _id: 'sent', count: 3 }]);
    mockPriceDropAggregate.mockResolvedValue([{ _id: 'sent', count: 2 }]);
    mockReengagementAggregate.mockResolvedValue([{ _id: 'blocked', count: 1 }, { _id: 'sent', count: 4 }]);
    mockSmsOptOutCount.mockResolvedValue(2);
    mockEmailOptOutCount.mockResolvedValue(1);

    const req = { query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z' }, orgId: '507f1f77bcf86cd799439011' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCrmReportsOverview(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    const response = json.mock.calls[0][0];
    expect(response.data.smsCampaigns).toEqual({ sent: 5, failed: 1 });
    expect(response.data.emailCampaigns).toEqual({ sent: 3 });
    expect(response.data.priceDropEmails).toEqual({ sent: 2 });
    expect(response.data.vehicleReengagement).toEqual({ blocked: 1, sent: 4 });
    expect(response.data.unsubscribes).toEqual({ sms: 2, email: 1 });
  });

  it('anchors SMS/Email recipient date-bucketing on the one-time claim timestamp (sentAt / processingStartedAt), never on updatedAt, so a later delivery webhook or reclaim sweep cannot move a recipient into the wrong reporting period', async () => {
    const req = { query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z' }, orgId: '507f1f77bcf86cd799439011' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCrmReportsOverview(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    const smsMatch = mockSmsRecipientAggregate.mock.calls[0][0][0].$match;
    expect(smsMatch).toHaveProperty('sentAt');
    expect(smsMatch).not.toHaveProperty('updatedAt');

    const emailMatch = mockEmailRecipientAggregate.mock.calls[0][0][0].$match;
    expect(emailMatch).toHaveProperty('processingStartedAt');
    expect(emailMatch).not.toHaveProperty('updatedAt');
  });

  it('maps the SMS delivery-status aggregate into a counts object, defaulting a null deliveryStatus to "accepted", and scopes it to status:"sent" only', async () => {
    mockSmsRecipientAggregate
      .mockResolvedValueOnce([{ _id: 'sent', count: 9 }])
      .mockResolvedValueOnce([{ _id: 'delivered', count: 6 }, { _id: 'delivery_failed', count: 1 }, { _id: null, count: 2 }]);

    const req = { query: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-07T23:59:59.999Z' }, orgId: '507f1f77bcf86cd799439011' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCrmReportsOverview(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    const deliveryPipeline = mockSmsRecipientAggregate.mock.calls[1][0];
    expect(deliveryPipeline[0].$match.status).toBe('sent');

    const response = json.mock.calls[0][0];
    expect(response.data.smsDeliveryStatus).toEqual({ delivered: 6, delivery_failed: 1, accepted: 2 });
  });

  it('builds a zero-filled leads-over-time series across the requested range, using only the demo-excluded leads', async () => {
    mockLeadFind.mockReturnValue(selectLean([
      { status: 'New', source: 'Website Chat', channel: 'webchat', phone: '', createdAt: new Date('2026-10-02T15:00:00.000Z') },
      { status: 'New', source: 'Website Chat', channel: 'webchat', phone: '', createdAt: new Date('2026-10-02T20:00:00.000Z') },
      { status: 'New', source: 'Demo', channel: 'sms', phone: '+18015550101', createdAt: new Date('2026-10-03T12:00:00.000Z') },
      { status: 'New', source: 'Website Chat', channel: 'webchat', phone: '', createdAt: new Date('2026-10-04T12:00:00.000Z') },
    ]));

    const req = { query: { from: '2026-10-01T06:00:00.000Z', to: '2026-10-06T05:59:59.999Z' }, orgId: '507f1f77bcf86cd799439011' } as any;
    const json = jest.fn();
    const res = { json } as any;
    const next = jest.fn();

    getCrmReportsOverview(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    const response = json.mock.calls[0][0];
    expect(response.data.leads.overTime).toEqual([
      { date: '2026-10-01', count: 0 },
      { date: '2026-10-02', count: 2 },
      { date: '2026-10-03', count: 0 },
      { date: '2026-10-04', count: 1 },
      { date: '2026-10-05', count: 0 },
    ]);
  });
});
