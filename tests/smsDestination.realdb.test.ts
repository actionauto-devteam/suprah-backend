const mockSendSms = jest.fn();

jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550000',
  sendSms: mockSendSms,
}));

import mongoose from 'mongoose';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import { sendSmsFromUser, sendAutomatedSms, sendStaffAttributedSms } from '../src/services/communication.service';
import { SmsDestinationError } from '../src/utils/smsDestination';

describe('Real-DB proof: untextable numbers never create conversation or message records', () => {
  const orgId = new mongoose.Types.ObjectId();
  const actor = { userId: 'staff-rdb', name: 'Real DB Staff' };

  beforeAll(() => {
    jest.setTimeout(30000);
  });

  beforeEach(() => {
    mockSendSms.mockReset();
    mockSendSms.mockImplementation(async () => ({ id: `rdb-${Math.random().toString(36).slice(2)}` }));
  });

  afterAll(async () => {
    await CommunicationMessage.deleteMany({ orgId });
    await Conversation.deleteMany({ orgId });
    await SmsOptOut.deleteMany({ organizationId: String(orgId) });
  });

  async function recordCounts() {
    const [conversations, messages] = await Promise.all([
      Conversation.countDocuments({ orgId }),
      CommunicationMessage.countDocuments({ orgId }),
    ]);
    return { conversations, messages };
  }

  it.each([
    ['385-503-5869 x12', 'manual'],
    ['385-503-5869;ext=12', 'manual'],
    ['503-5869', 'manual'],
    ['+385503586912', 'manual'],
    ['+180170268', 'manual'],
    ['+44 (0) 20 7946 0958', 'manual'],
    ['+639171234567', 'automated'],
    ['+18765551234', 'automated'],
  ] as const)('rejects %p (%s) with zero records written and no provider call', async (toPhone, destinationPolicy) => {
    const before = await recordCounts();

    await expect(
      sendSmsFromUser({ orgId, user: actor, toPhone, body: 'Real DB check', destinationPolicy }),
    ).rejects.toBeInstanceOf(SmsDestinationError);

    expect(await recordCounts()).toEqual(before);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('rejects campaign-style and automated sends to a non-US/Canada number with zero records', async () => {
    const before = await recordCounts();

    await expect(sendAutomatedSms({ orgId, toPhone: '+63 917 123 4567', body: 'Reminder' })).rejects.toBeInstanceOf(SmsDestinationError);
    await expect(sendStaffAttributedSms({ orgId, toPhone: '+63 917 123 4567', body: 'Sale', actor })).rejects.toBeInstanceOf(SmsDestinationError);

    expect(await recordCounts()).toEqual(before);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('still writes exactly one conversation and one sent message for a valid US number', async () => {
    const result = await sendSmsFromUser({ orgId, user: actor, toPhone: '(385) 503-5869', body: 'Valid US text' });

    const conversation: any = await Conversation.findById(result.conversation._id).lean();
    const message: any = await CommunicationMessage.findById(result.message._id).lean();
    expect(conversation.customerPhone).toBe('+13855035869');
    expect(message.to).toBe('+13855035869');
    expect(message.status).toBe('sent');
    expect(mockSendSms).toHaveBeenCalledWith('+13855035869', 'Valid US text');
  });

  it('writes a manual international text to the same +63 conversation key', async () => {
    const result = await sendSmsFromUser({
      orgId,
      user: actor,
      toPhone: '+63 917 123 4567',
      body: 'Manual international text',
      destinationPolicy: 'manual',
    });

    const conversation: any = await Conversation.findById(result.conversation._id).lean();
    expect(conversation.customerPhone).toBe('+639171234567');
    expect(mockSendSms).toHaveBeenCalledWith('+639171234567', 'Manual international text');
  });

  it('keeps an existing STOP opt-out in force with no new records', async () => {
    await SmsOptOut.create({ organizationId: String(orgId), phone: '+18015550142', optedOut: true, changedAt: new Date(), keyword: 'STOP' });
    const before = await recordCounts();

    await expect(sendAutomatedSms({ orgId, toPhone: '801-555-0142', body: 'Should not send' })).resolves.toBe(false);

    expect(await recordCounts()).toEqual(before);
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('still sends to a Demo Lab number through the automated policy', async () => {
    await expect(sendAutomatedSms({ orgId, toPhone: '+18015550177', body: 'Demo reminder' })).resolves.toBe(true);
    expect(mockSendSms).toHaveBeenCalledWith('+18015550177', 'Demo reminder');
  });
});
