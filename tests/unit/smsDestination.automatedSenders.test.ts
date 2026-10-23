const mockSendStaffAttributedSms = jest.fn();
const mockSendWebchatFallbackSms = jest.fn();
const mockSendSystemSms = jest.fn();
const mockCampaignFind = jest.fn();
const mockCampaignFindOneAndUpdate = jest.fn();
const mockCampaignFindOne = jest.fn();
const mockCampaignUpdateOne = jest.fn();
const mockRecipientFind = jest.fn();
const mockRecipientFindOneAndUpdate = jest.fn();
const mockRecipientUpdateOne = jest.fn();
const mockRecipientCountDocuments = jest.fn();
const mockSessionFind = jest.fn();
const mockSessionUpdateOne = jest.fn();
const mockWebChatMessageExists = jest.fn();
const mockAppointmentUpdateOne = jest.fn();
const mockSendAppointmentReminder = jest.fn();

jest.mock('../../src/services/communication.service', () => ({
  sendStaffAttributedSms: mockSendStaffAttributedSms,
  sendWebchatFallbackSms: mockSendWebchatFallbackSms,
  sendSystemSms: mockSendSystemSms,
}));
jest.mock('../../src/models/SmsCampaign.model', () => ({
  __esModule: true,
  default: {
    find: mockCampaignFind,
    findOneAndUpdate: mockCampaignFindOneAndUpdate,
    findOne: mockCampaignFindOne,
    updateOne: mockCampaignUpdateOne,
  },
}));
jest.mock('../../src/models/SmsCampaignRecipient.model', () => ({
  __esModule: true,
  default: {
    find: mockRecipientFind,
    findOneAndUpdate: mockRecipientFindOneAndUpdate,
    updateOne: mockRecipientUpdateOne,
    countDocuments: mockRecipientCountDocuments,
  },
}));
jest.mock('../../src/models/WebChatSession.model', () => ({
  __esModule: true,
  default: { find: mockSessionFind, updateOne: mockSessionUpdateOne },
}));
jest.mock('../../src/models/WebChatMessage.model', () => ({
  __esModule: true,
  default: { exists: mockWebChatMessageExists },
}));
jest.mock('../../src/models/Appointment.model', () => ({
  __esModule: true,
  default: { updateOne: mockAppointmentUpdateOne },
}));
jest.mock('../../src/services/email.service', () => ({
  __esModule: true,
  default: { sendAppointmentReminder: mockSendAppointmentReminder },
}));
jest.mock('../../src/utils/sendingWindow', () => ({ isWithinSendingHours: jest.fn(() => true) }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { runSmsCampaignSweep } from '../../src/schedulers/smsCampaign.scheduler';
import { runWebchatSmsFallbackSweep } from '../../src/schedulers/webchatSmsFallback.scheduler';
import { sendReminderFor } from '../../src/schedulers/appointmentReminder.scheduler';
import { SmsDestinationError } from '../../src/utils/smsDestination';

describe('SMS campaign scheduler with an untextable recipient', () => {
  const campaign = { _id: 'campaign-1', organizationId: 'org-1', message: 'Big sale! Reply STOP to opt out.', createdBy: 'user-1', createdByName: 'Jamie' };
  const recipient = { _id: 'recipient-1', phone: '+639171234567', leadId: 'lead-1', customerName: 'Pat' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCampaignFind.mockReturnValue({ sort: () => ({ limit: () => ({ lean: jest.fn().mockResolvedValue([campaign]) }) }) });
    mockCampaignFindOneAndUpdate.mockResolvedValue(campaign);
    mockRecipientFind.mockReturnValue({ limit: () => ({ lean: jest.fn().mockResolvedValue([recipient]) }) });
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockRecipientUpdateOne.mockResolvedValue({});
    mockCampaignUpdateOne.mockResolvedValue({});
    mockRecipientCountDocuments.mockResolvedValue(0);
  });

  it('marks the recipient skipped with the reason instead of sent or failed', async () => {
    mockSendStaffAttributedSms.mockRejectedValue(new SmsDestinationError('country_not_allowed', 'automated'));

    await runSmsCampaignSweep();

    expect(mockRecipientUpdateOne).toHaveBeenCalledWith(
      { _id: 'recipient-1' },
      { $set: { status: 'skipped', failureReason: 'Automatic texts only go to numbers in the US, US territories, and Canada.' }, $unset: { sentAt: 1 } },
    );
    expect(mockCampaignUpdateOne).toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { skippedCount: 1 } });
    expect(mockCampaignUpdateOne).not.toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { failedCount: 1 } });
    expect(mockCampaignUpdateOne).not.toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { sentCount: 1 } });
  });

  it('still records other provider errors as failed', async () => {
    mockSendStaffAttributedSms.mockRejectedValue(new Error('SMS provider rejected the message'));

    await runSmsCampaignSweep();

    expect(mockRecipientUpdateOne).toHaveBeenCalledWith(
      { _id: 'recipient-1' },
      { $set: { status: 'failed', failureReason: 'SMS provider rejected the message' } },
    );
    expect(mockCampaignUpdateOne).toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { failedCount: 1 } });
  });
});

describe('Web Chat SMS fallback with an untextable visitor number', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSessionFind.mockReturnValue({
      select: () => ({ limit: () => ({ lean: jest.fn().mockResolvedValue([{ _id: 'session-1', organizationId: 'org-1', visitorPhone: '555-12', visitorName: 'Pat Lee', leadId: 'lead-1' }]) }) }),
    });
    mockWebChatMessageExists.mockResolvedValue(null);
    mockSessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  });

  it('counts the session as skipped, not an error, and never retries it', async () => {
    mockSendWebchatFallbackSms.mockRejectedValue(new SmsDestinationError('incomplete', 'automated'));

    const stats = await runWebchatSmsFallbackSweep();

    expect(stats).toEqual({ scanned: 1, sent: 0, skipped: 1, errors: 0 });
    expect(mockSessionUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockSessionUpdateOne).toHaveBeenCalledWith(
      { _id: 'session-1', smsFallbackSentAt: null },
      { $set: { smsFallbackSentAt: expect.any(Date) } },
      { timestamps: false },
    );
  });
});

describe('appointment reminder text status', () => {
  const startTime = new Date('2026-10-23T18:00:00.000Z');
  const baseAppointment = {
    _id: 'appt-1',
    organizationId: 'org-1',
    title: 'Test drive',
    startTime,
    leadId: 'lead-1',
    guestEmails: [],
  };
  const withPhone = (phone: string, extra: Record<string, unknown> = {}) => ({
    ...baseAppointment,
    customerBooking: { phone, firstName: 'Pat', ...extra },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockAppointmentUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockSendAppointmentReminder.mockResolvedValue(undefined);
    mockSendSystemSms.mockResolvedValue({ messageId: '64b7f0c2a1b2c3d4e5f60718', providerMessageId: 'tx-reminder' });
  });

  it('skips only the text, records why for this appointment time, and still sends the email reminder', async () => {
    await sendReminderFor(withPhone('385-503-5869 ext 12', { email: 'pat@example.com' }));

    expect(mockSendSystemSms).not.toHaveBeenCalled();
    expect(mockAppointmentUpdateOne).toHaveBeenCalledWith(
      { _id: 'appt-1', startTime },
      { $set: { reminderSms: expect.objectContaining({ status: 'not_sent', reason: 'The phone number includes an extension, so it cannot be texted.', forStartTime: startTime }) } },
      { timestamps: false },
    );
    expect(mockSendAppointmentReminder).toHaveBeenCalledWith(expect.anything(), 'pat@example.com', 'Pat', 'org-1');
  });

  it('marks the text as sending, then accepted by the carrier with its ids', async () => {
    await sendReminderFor(withPhone('(385) 503-5869'));

    expect(mockAppointmentUpdateOne).toHaveBeenNthCalledWith(
      1,
      { _id: 'appt-1', startTime },
      { $set: { reminderSms: expect.objectContaining({ status: 'sending', forStartTime: startTime }) } },
      { timestamps: false },
    );
    expect(mockSendSystemSms).toHaveBeenCalledWith(expect.objectContaining({ toPhone: '(385) 503-5869', leadId: 'lead-1' }));
    expect(mockAppointmentUpdateOne).toHaveBeenNthCalledWith(
      2,
      { _id: 'appt-1', startTime, 'reminderSms.forStartTime': startTime, 'reminderSms.status': 'sending' },
      { $set: expect.objectContaining({ 'reminderSms.status': 'accepted', 'reminderSms.providerMessageId': 'tx-reminder' }) },
      { timestamps: false },
    );
  });

  it('does not text the customer when the appointment time changed after the job started', async () => {
    mockAppointmentUpdateOne.mockResolvedValueOnce({ matchedCount: 0 });

    await sendReminderFor(withPhone('(385) 503-5869'));

    expect(mockSendSystemSms).not.toHaveBeenCalled();
    expect(mockAppointmentUpdateOne).toHaveBeenCalledTimes(1);
  });

  it('records STOP as not sent', async () => {
    mockSendSystemSms.mockResolvedValueOnce(false);

    await sendReminderFor(withPhone('(385) 503-5869'));

    expect(mockAppointmentUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'reminderSms.status': 'sending' }),
      { $set: expect.objectContaining({ 'reminderSms.status': 'not_sent', 'reminderSms.reason': 'This customer replied STOP, so texting is turned off.' }) },
      { timestamps: false },
    );
  });

  it.each([
    [Object.assign(new Error('SMS provider rejected the message'), { statusCode: 502 }), 'failed'],
    [Object.assign(new Error('accepted but not recorded'), { name: 'SmsDeliveryUncertainError', providerMessageId: 'tx-uncertain' }), 'unknown'],
  ])('never reports success when the send fails or is uncertain (%#)', async (error, status) => {
    mockSendSystemSms.mockRejectedValueOnce(error);

    await sendReminderFor(withPhone('(385) 503-5869'));

    expect(mockAppointmentUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'reminderSms.status': 'sending' }),
      { $set: expect.objectContaining({ 'reminderSms.status': status }) },
      { timestamps: false },
    );
  });
});

describe('automated senders and Do Not Contact customers', () => {
  const { ContactRestrictedError } = jest.requireActual('../../src/services/contactRestriction.service');
  const blocked = () => new ContactRestrictedError({ status: 'restricted', leadIds: ['lead-old'], onThisLead: false });
  const DNC_MESSAGE = "This customer is marked Do Not Contact on another lead, so messages can't be sent. Only an admin can remove Do Not Contact.";

  it('marks an SMS campaign recipient skipped with the Do Not Contact reason, not failed', async () => {
    jest.clearAllMocks();
    const campaign = { _id: 'campaign-1', organizationId: 'org-1', message: 'Big sale! Reply STOP to opt out.', createdBy: 'user-1', createdByName: 'Jamie' };
    const recipient = { _id: 'recipient-1', phone: '+13855035869', leadId: 'lead-1', customerName: 'Pat' };
    mockCampaignFind.mockReturnValue({ sort: () => ({ limit: () => ({ lean: jest.fn().mockResolvedValue([campaign]) }) }) });
    mockCampaignFindOneAndUpdate.mockResolvedValue(campaign);
    mockRecipientFind.mockReturnValue({ limit: () => ({ lean: jest.fn().mockResolvedValue([recipient]) }) });
    mockRecipientFindOneAndUpdate.mockResolvedValue(recipient);
    mockRecipientUpdateOne.mockResolvedValue({});
    mockCampaignUpdateOne.mockResolvedValue({});
    mockRecipientCountDocuments.mockResolvedValue(0);
    mockSendStaffAttributedSms.mockRejectedValue(blocked());

    await runSmsCampaignSweep();

    expect(mockRecipientUpdateOne).toHaveBeenCalledWith(
      { _id: 'recipient-1' },
      { $set: { status: 'skipped', failureReason: DNC_MESSAGE }, $unset: { sentAt: 1 } },
    );
    expect(mockCampaignUpdateOne).toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { skippedCount: 1 } });
    expect(mockCampaignUpdateOne).not.toHaveBeenCalledWith({ _id: 'campaign-1' }, { $inc: { failedCount: 1 } });
  });

  it('counts the Web Chat SMS fallback as skipped, not an error', async () => {
    jest.clearAllMocks();
    mockSessionFind.mockReturnValue({
      select: () => ({ limit: () => ({ lean: jest.fn().mockResolvedValue([{ _id: 'session-1', organizationId: 'org-1', visitorPhone: '3855035869', visitorName: 'Pat Lee', leadId: 'lead-1' }]) }) }),
    });
    mockWebChatMessageExists.mockResolvedValue(null);
    mockSessionUpdateOne.mockResolvedValue({ modifiedCount: 1 });
    mockSendWebchatFallbackSms.mockRejectedValue(blocked());

    await expect(runWebchatSmsFallbackSweep()).resolves.toEqual({ scanned: 1, sent: 0, skipped: 1, errors: 0 });
  });

  it('records the reminder text as not sent with the Do Not Contact reason', async () => {
    jest.clearAllMocks();
    mockAppointmentUpdateOne.mockResolvedValue({ matchedCount: 1 });
    mockSendAppointmentReminder.mockResolvedValue(undefined);
    mockSendSystemSms.mockRejectedValue(blocked());
    const startTime = new Date('2026-10-23T18:00:00.000Z');

    await sendReminderFor({ _id: 'appt-1', organizationId: 'org-1', title: 'Test drive', startTime, leadId: 'lead-1', guestEmails: [], customerBooking: { phone: '(385) 503-5869', firstName: 'Pat' } });

    expect(mockAppointmentUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'reminderSms.status': 'sending' }),
      { $set: expect.objectContaining({ 'reminderSms.status': 'not_sent', 'reminderSms.reason': DNC_MESSAGE }) },
      { timestamps: false },
    );
  });
});
