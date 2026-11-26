import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import SmsCampaignRecipient from '../src/models/SmsCampaignRecipient.model';
import LeadHandlingEvent from '../src/models/LeadHandlingEvent.model';
import { CallLog, CommunicationMessage } from '../src/models/communication.model';
import { buildRepOutreach } from '../src/services/crmRepOutreach.service';

const org = new mongoose.Types.ObjectId();
const otherOrg = new mongoose.Types.ObjectId();
const orgKey = String(org);
const rep = new mongoose.Types.ObjectId();
const repKey = String(rep);
const from = new Date('2026-11-25T07:00:00.000Z');
const to = new Date('2026-11-26T06:59:59.999Z');
const at = (hours: number) => new Date(from.getTime() + hours * 60 * 60 * 1000);
const leads: Record<string, mongoose.Types.ObjectId> = {};

function lead(name: string, fields: Record<string, any> = {}) {
  const _id = new mongoose.Types.ObjectId();
  leads[name] = _id;
  return {
    _id,
    organizationId: org,
    firstName: name,
    lastName: 'Test',
    phone: '+18015550199',
    source: 'Cars.com',
    channel: 'sms',
    status: 'Contacted',
    createdAt: at(-200),
    updatedAt: at(-200),
    ...fields,
  };
}

function text(leadName: string | null, fields: Record<string, any> = {}) {
  return {
    orgId: orgKey,
    conversationId: new mongoose.Types.ObjectId(),
    leadId: leadName ? leads[leadName] : null,
    direction: 'outbound',
    body: 'Hi',
    from: '+13855100468',
    to: '+18015550199',
    status: 'delivered',
    sentBy: { userId: repKey, name: 'Rep' },
    createdAt: at(2),
    updatedAt: at(2),
    ...fields,
  };
}

function call(leadName: string | null, fields: Record<string, any> = {}) {
  return {
    orgId: orgKey,
    leadId: leadName ? leads[leadName] : null,
    direction: 'outbound',
    from: '+13855100468',
    to: '+18015550199',
    status: 'completed',
    placedBy: { userId: repKey, name: 'Rep' },
    createdAt: at(3),
    updatedAt: at(3),
    ...fields,
  };
}

function email(leadName: string, fields: Record<string, any> = {}) {
  return {
    organizationId: orgKey,
    leadId: leads[leadName],
    action: 'email_sent',
    channel: 'email',
    actor: { userId: repKey },
    at: at(4),
    createdAt: at(4),
    updatedAt: at(4),
    ...fields,
  };
}

describe('Real-DB proof: rep texts, emails and calls on the CRM Reports overview (local MongoDB only)', () => {
  beforeAll(async () => {
    await Lead.collection.insertMany([
      lead('Ana'),
      lead('Ben', { status: 'New' }),
      lead('Others', { status: 'Not a Lead' }),
      lead('Demo', { source: 'Demo', phone: '+18015550101' }),
      lead('Other org', { organizationId: otherOrg }),
    ] as any[]);
    await Lead.collection.insertOne(lead('Old copy', { combinedInto: { leadId: leads.Ben, at: at(-1) } }) as any);

    await CommunicationMessage.collection.insertMany([
      text('Ana'),
      text('Ana', { orgId: org, createdAt: at(5) }),
      text('Ben'),
      text('Ben', { sentBy: { userId: 'ai-agent', name: 'AI' } }),
      text('Ben', { sentBy: { userId: 'system', name: 'Automation' } }),
      text('Ben', { sentBy: null }),
      text('Ben', { status: 'failed' }),
      text('Ben', { providerMessageId: 'campaign-1' }),
      text('Ben', { createdAt: at(30) }),
      text('Ben', { direction: 'inbound', sentBy: null }),
      text('Others'),
      text('Demo'),
      text(null),
      text('Other org', { orgId: String(otherOrg) }),
      text('Ana', { orgId: String(otherOrg), createdAt: at(1) }),
    ] as any[]);
    await SmsCampaignRecipient.collection.insertOne({
      campaignId: new mongoose.Types.ObjectId(),
      organizationId: orgKey,
      leadId: leads.Ben,
      phone: '+18015550199',
      status: 'sent',
      sentAt: at(2),
      providerMessageId: 'campaign-1',
    } as any);

    await LeadHandlingEvent.collection.insertMany([
      email('Ana'),
      email('Ana', { at: at(6) }),
      email('Old copy'),
      email('Ana', { actor: { userId: 'ai-agent' } }),
      email('Others'),
      email('Ana', { at: at(-30) }),
      email('Other org', { organizationId: String(otherOrg) }),
      email('Ana', { action: 'took_over' }),
    ] as any[]);

    await CallLog.collection.insertMany([
      call('Ana'),
      call('Ben', { placedBy: { userId: rep, name: 'Rep' } }),
      call('Ben', { placedBy: null }),
      call('Ben', { direction: 'inbound', placedBy: null }),
      call('Others'),
      call(null),
      call('Ana', { createdAt: at(-30) }),
    ] as any[]);
  });

  it('counts each lead once and every text, email and call a rep sent in the period', async () => {
    const outreach = await buildRepOutreach(orgKey, from, to);

    expect(outreach.texts).toEqual({ leads: 2, sent: 3 });
    expect(outreach.emails).toEqual({ leads: 2, sent: 3 });
    expect(outreach.calls).toEqual({ leads: 2, sent: 2 });
  });

  it('shows zero for a period with no rep activity', async () => {
    const outreach = await buildRepOutreach(orgKey, at(48), at(72));

    expect(outreach).toEqual({ texts: { leads: 0, sent: 0 }, emails: { leads: 0, sent: 0 }, calls: { leads: 0, sent: 0 } });
  });

  it('keeps another organization separate', async () => {
    const outreach = await buildRepOutreach(String(otherOrg), from, to);

    expect(outreach.texts).toEqual({ leads: 1, sent: 1 });
    expect(outreach.emails).toEqual({ leads: 1, sent: 1 });
    expect(outreach.calls).toEqual({ leads: 0, sent: 0 });
  });
});
