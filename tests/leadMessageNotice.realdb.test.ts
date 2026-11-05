import mongoose from 'mongoose';

const mockNotifyUsers = jest.fn().mockResolvedValue(undefined);
const mockNotifyOrgAdmins = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/utils/safeNotification', () => ({
  notifyUsers: (...args: unknown[]) => mockNotifyUsers(...args),
  notifyOrgAdmins: (...args: unknown[]) => mockNotifyOrgAdmins(...args),
}));

import { notifyLeadMessage, notifyLeadMessageUnlessHandoff, leadDisplayName } from '../src/services/leadMessageNotice.service';
import Notification from '../src/models/Notification.model';
import { notificationTemplates } from '../src/utils/notificationTemplates';
import { NOTIFICATION_TYPES } from '../src/constants/notificationTypes';

const orgId = String(new mongoose.Types.ObjectId());
const repId = String(new mongoose.Types.ObjectId());
const old = new Date(Date.now() - 3 * 86400000);

describe('Desktop and bell notices for customer texts and emails', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is a registered notification type with a plain title and a short preview', () => {
    expect(NOTIFICATION_TYPES).toContain('lead_message');
    expect(notificationTemplates.lead_message({ customerName: 'Jordan Lee', channel: 'sms', preview: '  Is the   Tacoma still there? ' }))
      .toEqual({ title: 'New text from Jordan Lee', message: 'Is the Tacoma still there?' });
    const long = notificationTemplates.lead_message({ customerName: 'Jordan Lee', channel: 'email', preview: 'x'.repeat(300) });
    expect(long.title).toBe('New email from Jordan Lee'); expect(long.message).toHaveLength(140); expect(long.message.endsWith('...')).toBe(true);
    expect(notificationTemplates.lead_message({ customerName: 'Jordan Lee', channel: 'email', preview: '' }).message).toBe('Jordan Lee sent a new email.');
  });

  it('goes to the rep assigned to the lead, and opens that lead', async () => {
    const lead = { _id: new mongoose.Types.ObjectId(), firstName: 'Jordan', lastName: 'Lee', phone: '+18015550161', assignedTo: repId, createdAt: old };
    expect(await notifyLeadMessage(orgId, lead, 'sms', 'Is the Tacoma still there?')).toBe(true);
    expect(mockNotifyUsers).toHaveBeenCalledWith([repId], orgId, 'lead_message', 'New text from Jordan Lee', 'Is the Tacoma still there?', expect.objectContaining({ route: `/crm/leads?leadId=${lead._id}`, pushTag: `lead-message-${lead._id}`, channel: 'sms' }));
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('goes to the admins when nobody is assigned, and names the customer by number when there is no name', async () => {
    const lead = { _id: new mongoose.Types.ObjectId(), phone: '+18015550162', createdAt: old };
    expect(leadDisplayName(lead)).toBe('(801) 555-0162');
    expect(leadDisplayName({ firstName: 'Unknown', phone: '+18015550182' })).toBe('(801) 555-0182');
    expect(leadDisplayName({ firstName: 'unknown', lastName: 'Lee', phone: '+18015550182' })).toBe('Lee');
    expect(leadDisplayName({ firstName: 'Unknown', email: 'pat@example.com' })).toBe('pat@example.com');
    expect(leadDisplayName({ firstName: 'Unknown', phone: '+44 20 7946 0958' })).toBe('+44 20 7946 0958');
    await notifyLeadMessage(orgId, lead, 'email', 'Re: your quote');
    expect(mockNotifyOrgAdmins).toHaveBeenCalledWith(orgId, 'lead_message', 'New email from (801) 555-0162', 'Re: your quote', expect.objectContaining({ channel: 'email' }));
    expect(mockNotifyUsers).not.toHaveBeenCalled();
  });

  it('stays quiet for a lead created in the last minute, because the New lead notice already went out', async () => {
    const fresh = { _id: new mongoose.Types.ObjectId(), firstName: 'New', assignedTo: repId, createdAt: new Date() };
    expect(await notifyLeadMessage(orgId, fresh, 'sms', 'hello')).toBe(false);
    expect(await notifyLeadMessage(orgId, null, 'sms', 'hello')).toBe(false);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('a text while the AI is paused for a human still notifies the rep, unless the customer-waiting notice for that lead just went out', async () => {
    const lead = { _id: new mongoose.Types.ObjectId(), firstName: 'Casey', lastName: 'Park', assignedTo: repId, createdAt: old };
    expect(await notifyLeadMessageUnlessHandoff(orgId, lead, 'sms', 'Hello? Anyone there?')).toBe(true);
    expect(mockNotifyUsers).toHaveBeenCalledWith([repId], orgId, 'lead_message', 'New text from Casey Park', 'Hello? Anyone there?', expect.any(Object));
    mockNotifyUsers.mockClear();
    const handoff = await Notification.collection.insertOne({ organizationId: orgId, userId: repId, type: 'ai_agent_handoff_needed', category: 'crm', title: 'Waiting', message: 'x', metadata: { leadId: String(lead._id) }, isRead: false, createdAt: new Date(), updatedAt: new Date() } as any);
    expect(await notifyLeadMessageUnlessHandoff(orgId, lead, 'sms', 'I need help')).toBe(false);
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    await Notification.collection.updateOne({ _id: handoff.insertedId }, { $set: { createdAt: new Date(Date.now() - 3 * 60_000) } });
    expect(await notifyLeadMessageUnlessHandoff(orgId, lead, 'sms', 'Still waiting')).toBe(true);
    expect(mockNotifyUsers).toHaveBeenCalledTimes(1);
    const otherOrg = String(new mongoose.Types.ObjectId());
    await Notification.collection.updateOne({ _id: handoff.insertedId }, { $set: { createdAt: new Date(), organizationId: otherOrg } });
    expect(await notifyLeadMessageUnlessHandoff(orgId, lead, 'sms', 'Other org handoff does not count')).toBe(true);
    await Notification.collection.deleteOne({ _id: handoff.insertedId });
  });

  it('never breaks message handling when the notice fails', async () => {
    mockNotifyUsers.mockRejectedValueOnce(new Error('down'));
    const lead = { _id: new mongoose.Types.ObjectId(), firstName: 'Jordan', assignedTo: repId, createdAt: old };
    await expect(notifyLeadMessage(orgId, lead, 'sms', 'hi')).resolves.toBe(false);
  });
});
