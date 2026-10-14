const mockLeadFindOne = jest.fn();
const mockConversationFind = jest.fn();
const mockMessageFind = jest.fn();
const mockCallFind = jest.fn();
const mockWebChatFind = jest.fn();
const mockAppointmentFind = jest.fn();
const mockMailConversationFind = jest.fn();
const mockMailMessageFind = jest.fn();
const mockCampaignRecipientFind = jest.fn();
const mockEmailCampaignFind = jest.fn();
const mockPriceDropLogFind = jest.fn();

jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: { findOne: mockLeadFindOne } }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: { find: mockAppointmentFind } }));
jest.mock('../../src/models/WebChatMessage.model', () => ({ __esModule: true, default: { find: mockWebChatFind } }));
jest.mock('../../src/models/MailConversation.model', () => ({ __esModule: true, default: { find: mockMailConversationFind } }));
jest.mock('../../src/models/MailMessage.model', () => ({ __esModule: true, default: { find: mockMailMessageFind } }));
jest.mock('../../src/models/EmailCampaignRecipient.model', () => ({ __esModule: true, default: { find: mockCampaignRecipientFind } }));
jest.mock('../../src/models/EmailCampaign.model', () => ({ __esModule: true, default: { find: mockEmailCampaignFind } }));
jest.mock('../../src/models/PriceDropEmailLog.model', () => ({ __esModule: true, default: { find: mockPriceDropLogFind } }));
jest.mock('../../src/models/communication.model', () => ({
  Conversation: { find: mockConversationFind },
  CommunicationMessage: { find: mockMessageFind },
  CallLog: { find: mockCallFind },
}));
jest.mock('../../src/services/communication.service', () => ({ normalizePhone: (value: string) => value }));
jest.mock('../../src/services/telnyx.service', () => ({}));

import { getLeadTimeline } from '../../src/controllers/communication.controller';

function selectLean(value: unknown) {
  return { select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(value) })) };
}

function sorted(value: unknown, reject = false) {
  const lean = reject ? jest.fn().mockRejectedValue(new Error('source unavailable')) : jest.fn().mockResolvedValue(value);
  return { sort: jest.fn(() => ({ limit: jest.fn(() => ({ lean })) })) };
}

describe('communication lead timeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLeadFindOne.mockReturnValue(selectLean({
      _id: 'lead-1',
      firstName: 'Alex',
      lastName: 'Rivera',
      email: '',
      phone: '+13035550123',
      channel: 'sms',
      source: 'Website',
      comments: 'Interested in the vehicle',
      notes: [],
      statusHistory: [],
      createdAt: new Date('2026-09-20T10:00:00.000Z'),
    }));
    mockConversationFind.mockReturnValue(selectLean([{ _id: 'conversation-1' }]));
    mockMessageFind.mockReturnValue(sorted([{
      _id: 'message-1',
      leadId: 'lead-1',
      direction: 'outbound',
      body: 'Hello Alex',
      status: 'delivered',
      sentBy: { name: 'Sam' },
      createdAt: new Date('2026-09-21T10:00:00.000Z'),
    }]));
    mockCallFind.mockReturnValue(sorted([]));
    mockWebChatFind.mockReturnValue(sorted([], true));
    mockAppointmentFind.mockReturnValue(sorted([]));
    mockMailConversationFind.mockReturnValue(selectLean([]));
    mockMailMessageFind.mockReturnValue(sorted([]));
    mockCampaignRecipientFind.mockReturnValue(sorted([]));
    mockEmailCampaignFind.mockReturnValue(selectLean([]));
    mockPriceDropLogFind.mockReturnValue(sorted([]));
  });

  it('keeps tenant filters and returns available sources when one source fails', async () => {
    const req = { params: { leadId: 'lead-1' }, query: {}, orgId: 'org-1' };
    const json = jest.fn();
    const res = { json };
    const next = jest.fn();

    (getLeadTimeline as any)(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(next).not.toHaveBeenCalled();
    expect(mockLeadFindOne).toHaveBeenCalledWith({ _id: 'lead-1', organizationId: 'org-1' });
    expect(mockMessageFind).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1' }));
    expect(mockWebChatFind).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1', leadId: 'lead-1' }));
    const response = json.mock.calls[0][0];
    expect(response.data.unavailableSources).toEqual(['webchat']);
    expect(response.data.items.map((item: any) => item.channel)).toEqual(expect.arrayContaining(['sms', 'note']));
    expect(response.data.items.find((item: any) => item.id === 'sms:message-1')).toEqual(expect.objectContaining({ status: 'delivered', actor: 'Sam' }));
  });

  it('includes sent Email Campaign and Price Drop events, resolving the campaign subject by id', async () => {
    mockCampaignRecipientFind.mockReturnValue(sorted([{
      _id: 'recipient-1',
      campaignId: 'campaign-1',
      status: 'sent',
      sentAt: new Date('2026-09-22T09:00:00.000Z'),
      updatedAt: new Date('2026-09-22T09:00:00.000Z'),
    }]));
    mockEmailCampaignFind.mockReturnValue(selectLean([{
      _id: 'campaign-1',
      name: 'October Promo',
      subject: 'Check out this deal',
      createdByName: 'Jordan',
    }]));
    mockPriceDropLogFind.mockReturnValue(sorted([{
      _id: 'log-1',
      vehicleId: 'vehicle-1',
      vehicleLabel: '2024 Civic',
      previousPrice: 25000,
      newPrice: 23000,
      matchMethod: 'vin',
      status: 'sent',
      sentAt: new Date('2026-09-23T09:00:00.000Z'),
      updatedAt: new Date('2026-09-23T09:00:00.000Z'),
    }]));

    const req = { params: { leadId: 'lead-1' }, query: {}, orgId: 'org-1' };
    const json = jest.fn();
    const res = { json };
    const next = jest.fn();

    (getLeadTimeline as any)(req, res, next);
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockCampaignRecipientFind).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      leadId: 'lead-1',
      status: { $in: ['sent', 'failed', 'uncertain'] },
    }));
    expect(mockPriceDropLogFind).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      leadId: 'lead-1',
      status: { $in: ['sent', 'failed'] },
    }));

    const response = json.mock.calls[0][0];
    const campaignItem = response.data.items.find((item: any) => item.id === 'campaign_email:recipient-1');
    expect(campaignItem).toEqual(expect.objectContaining({
      channel: 'campaign_email',
      status: 'sent',
      body: 'Check out this deal',
      actor: 'Jordan',
    }));
    expect(campaignItem.metadata).toEqual(expect.objectContaining({ campaignId: 'campaign-1', campaignName: 'October Promo' }));

    const priceDropItem = response.data.items.find((item: any) => item.id === 'price_drop:log-1');
    expect(priceDropItem).toEqual(expect.objectContaining({
      channel: 'price_drop',
      status: 'sent',
      body: '2024 Civic: $25000 -> $23000',
    }));
  });
});
