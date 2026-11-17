jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import MailConversation from '../src/models/MailConversation.model';
import MailMessage from '../src/models/MailMessage.model';
import LeadHandlingEvent from '../src/models/LeadHandlingEvent.model';
import { CallLog, CommunicationMessage, Conversation } from '../src/models/communication.model';
import {
  clearHandledByCache,
  getLeadHandlers,
  leadIdsHandledBy,
  recordLeadHandling,
} from '../src/services/leadHandling.service';
import { buildLeadTimeline } from '../src/controllers/communication.controller';
import { getAllLeads } from '../src/controllers/lead.controller';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const base = new Date('2026-11-10T16:00:00Z').getTime();
const t = (hours: number) => new Date(base + hours * 3_600_000);

const beth = new mongoose.Types.ObjectId();
const mary = new mongoose.Types.ObjectId();
const jom = new mongoose.Types.ObjectId();
const admin = new mongoose.Types.ObjectId();
const maryCrm = new mongoose.Types.ObjectId();
const jomCrm = new mongoose.Types.ObjectId();
const leadOne = new mongoose.Types.ObjectId();
const leadTwo = new mongoose.Types.ObjectId();
const leadThree = new mongoose.Types.ObjectId();
const leadFour = new mongoose.Types.ObjectId();
const conversationOne = new mongoose.Types.ObjectId();
const conversationTwo = new mongoose.Types.ObjectId();
const mailConversation = new mongoose.Types.ObjectId();

async function cleanup() {
  await Promise.all([
    Lead.collection.deleteMany({ organizationId: orgId }),
    User.collection.deleteMany({ organizationId: orgId }),
    CrmUser.collection.deleteMany({ organizationId: orgId }),
    WebChatMessage.collection.deleteMany({ organizationId: ORG }),
    MailConversation.collection.deleteMany({ organizationId: orgId }),
    MailMessage.collection.deleteMany({ organizationId: orgId }),
    LeadHandlingEvent.collection.deleteMany({ organizationId: ORG }),
    CallLog.collection.deleteMany({ orgId: { $in: [ORG, orgId] } }),
    CommunicationMessage.collection.deleteMany({ orgId: { $in: [ORG, orgId] } }),
    Conversation.collection.deleteMany({ orgId: { $in: [ORG, orgId] } }),
  ]);
}

describe('Real-DB: who handled a lead (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await cleanup();
    await User.collection.insertMany([
      { _id: beth, organizationId: orgId, name: 'Beth Reyes', email: 'beth@dealer.test', role: 'employee', isActive: true },
      { _id: mary, organizationId: orgId, name: 'Mary Cruz', email: 'Mary@Dealer.test', role: 'employee', isActive: true },
      { _id: jom, organizationId: orgId, name: 'Jom Santos', email: 'jom@dealer.test', role: 'employee', isActive: true },
      { _id: admin, organizationId: orgId, name: 'Avery Admin', email: 'avery@dealer.test', role: 'admin', isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: maryCrm, organizationId: orgId, fullName: 'Mary Cruz', email: 'mary@dealer.test', isActive: true },
      { _id: jomCrm, organizationId: orgId, fullName: 'Jom Santos', email: 'jom@dealer.test', isActive: true },
    ] as any[]);
    await Lead.collection.insertMany([
      {
        _id: leadOne,
        organizationId: orgId,
        firstName: 'Carla',
        lastName: 'Customer',
        phone: '+18015550101',
        email: 'carla@example.com',
        status: 'Contacted',
        channel: 'sms',
        source: 'Website',
        assignedTo: mary,
        assignedAt: t(4),
        assignmentHistory: [
          { _id: new mongoose.Types.ObjectId(), to: beth, changedBy: admin, changedAt: t(1) },
          { _id: new mongoose.Types.ObjectId(), from: beth, to: mary, changedBy: beth, changedAt: t(4) },
        ],
        statusHistory: [{ _id: new mongoose.Types.ObjectId(), from: 'New', to: 'Contacted', changedBy: beth, changedAt: t(2) }],
        notes: [
          { _id: new mongoose.Types.ObjectId(), text: 'Called back, left voicemail', createdBy: jomCrm, authorName: 'Jom Santos', authorType: 'user', createdAt: t(6) },
          { _id: new mongoose.Types.ObjectId(), text: 'AI summary note', authorName: 'Anna', authorType: 'ai', createdAt: t(6.5) },
        ],
        createdAt: t(0),
        updatedAt: t(8),
      },
      { _id: leadTwo, organizationId: orgId, firstName: 'Dan', lastName: 'Other', phone: '+18015550102', status: 'New', channel: 'sms', source: 'Website', createdAt: t(0), updatedAt: t(0) },
      { _id: leadThree, organizationId: orgId, firstName: 'Eve', lastName: 'Mailer', email: 'eve@example.com', status: 'New', channel: 'email', source: 'Website', createdAt: t(0), updatedAt: t(0) },
      { _id: leadFour, organizationId: orgId, firstName: 'Finn', lastName: 'Quiet', phone: '+18015550104', status: 'New', channel: 'sms', source: 'Website', createdAt: t(0), updatedAt: t(0) },
    ] as any[]);
    await Conversation.collection.insertMany([
      { _id: conversationOne, orgId: ORG, leadId: leadOne, customerPhone: '+18015550101', aiPausedAt: t(3.2), aiPausedBy: { userId: String(mary), name: 'Mary Cruz' }, createdAt: t(0), updatedAt: t(8) },
      { _id: conversationTwo, orgId: ORG, leadId: leadTwo, customerPhone: '+18015550102', createdAt: t(0), updatedAt: t(0) },
    ] as any[]);
    await CommunicationMessage.collection.insertMany([
      { orgId: ORG, conversationId: conversationOne, leadId: leadOne, direction: 'inbound', body: 'Hi', status: 'received', createdAt: t(0.5) },
      { orgId: ORG, conversationId: conversationOne, leadId: leadOne, direction: 'outbound', body: 'Welcome!', sentBy: { userId: 'system', name: 'Automation - Welcome' }, status: 'sent', createdAt: t(1.2) },
      { orgId: ORG, conversationId: conversationOne, leadId: leadOne, direction: 'outbound', body: 'Hi Carla, this is Anna', sentBy: { userId: 'ai-agent', name: 'Anna' }, status: 'sent', createdAt: t(1.5) },
      { orgId: ORG, conversationId: conversationOne, leadId: leadOne, direction: 'outbound', body: 'Hi Carla, Beth here', sentBy: { userId: String(beth), name: 'Beth Reyes' }, status: 'sent', createdAt: t(2) },
      { orgId: ORG, conversationId: conversationTwo, leadId: leadTwo, direction: 'outbound', body: 'Hi Dan', sentBy: { userId: String(jomCrm), name: 'Jom Santos' }, status: 'sent', createdAt: t(2) },
    ] as any[]);
    await WebChatMessage.collection.insertOne({ organizationId: ORG, sessionId: new mongoose.Types.ObjectId(), leadId: leadOne, direction: 'outbound', body: 'Mary here', sentBy: { userId: String(maryCrm), name: 'Mary Cruz' }, createdAt: t(5) } as any);
    await CallLog.collection.insertMany([
      { orgId: ORG, leadId: leadOne, direction: 'inbound', from: '+18015550101', to: '+18015550900', status: 'completed', answeredBy: { userId: String(mary), name: 'Mary Cruz' }, answeredAt: t(5.5), createdAt: t(5.4) },
      { orgId: ORG, leadId: leadOne, direction: 'outbound', from: '+18015550900', to: '+18015550101', status: 'completed', placedBy: { userId: String(jom), name: 'Jom Santos' }, createdAt: t(7) },
    ] as any[]);
    await LeadHandlingEvent.collection.insertMany([
      { organizationId: ORG, leadId: leadOne, action: 'email_sent', channel: 'email', actor: { userId: String(beth) }, at: t(2.5), createdAt: t(2.5) },
      { organizationId: ORG, leadId: leadOne, action: 'took_over', channel: 'sms', actor: { userId: String(maryCrm), name: 'Mary Cruz' }, at: t(3), createdAt: t(3) },
      { organizationId: ORG, leadId: leadOne, action: 'resumed', channel: 'sms', actor: { userId: String(maryCrm), name: 'Mary Cruz' }, at: t(8), createdAt: t(8) },
    ] as any[]);
    await MailConversation.collection.insertOne({ _id: mailConversation, organizationId: orgId, ownerCrmUserId: maryCrm, participants: [{ email: 'eve@example.com', name: 'Eve' }], subject: 'Your car', createdAt: t(1), updatedAt: t(1) } as any);
    await MailMessage.collection.insertOne({ conversationId: mailConversation, organizationId: orgId, ownerCrmUserId: maryCrm, direction: 'outbound', fromEmail: 'mary@dealer.test', fromName: 'Mary Cruz', toEmail: 'eve@example.com', bodyText: 'Hello Eve', attachments: [], status: 'sent', readByOwner: true, sentAt: t(1), createdAt: t(1) } as any);
  });

  beforeEach(() => clearHandledByCache());
  afterAll(cleanup);

  it('1. lists everyone who handled the customer, in order, with what each did', async () => {
    const result = await getLeadHandlers(ORG, String(leadOne));
    expect(result.people.map((person) => person.name)).toEqual(['Beth Reyes', 'Anna', 'Mary Cruz', 'Jom Santos']);
    const [bethRow, aiRow, maryRow, jomRow] = result.people;
    expect(bethRow).toMatchObject({ isAi: false, roles: ['first_reply', 'was_assigned'] });
    expect(bethRow.counts).toMatchObject({ texts: 1, emails: 1, statusChanges: 1, chats: 0 });
    expect(aiRow).toMatchObject({ isAi: true, roles: [] });
    expect(aiRow.counts.texts).toBe(1);
    expect(maryRow).toMatchObject({ roles: ['took_over', 'follow_up', 'assigned'], tookOverAt: t(3).toISOString(), assignedAt: t(4).toISOString() });
    expect(maryRow.counts).toMatchObject({ chats: 1, callsAnswered: 1 });
    expect(jomRow).toMatchObject({ roles: ['follow_up'] });
    expect(jomRow.counts).toMatchObject({ notes: 1, callsMade: 1 });
    expect(result.assignedTo).toMatchObject({ name: 'Mary Cruz', at: t(4).toISOString() });
    expect(result.assignments).toEqual([
      { toName: 'Mary Cruz', fromName: 'Beth Reyes', byName: 'Beth Reyes', at: t(4).toISOString() },
      { toName: 'Beth Reyes', fromName: null, byName: 'Avery Admin', at: t(1).toISOString() },
    ]);
  });

  it('2. an untouched lead has nobody; another org cannot read it', async () => {
    const quiet = await getLeadHandlers(ORG, String(leadFour));
    expect(quiet).toEqual({ people: [], assignedTo: null, assignments: [] });
    await expect(getLeadHandlers(String(new mongoose.Types.ObjectId()), String(leadOne))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('3. the Handled by filter finds every lead a person worked, by either of their logins', async () => {
    const sorted = (ids: mongoose.Types.ObjectId[]) => ids.map(String).sort();
    expect(sorted(await leadIdsHandledBy(ORG, String(mary)))).toEqual([String(leadOne), String(leadThree)].sort());
    expect(sorted(await leadIdsHandledBy(ORG, String(jom)))).toEqual([String(leadOne), String(leadTwo)].sort());
    expect(sorted(await leadIdsHandledBy(ORG, String(beth)))).toEqual([String(leadOne)]);
    expect(await leadIdsHandledBy(ORG, 'not-an-id')).toEqual([]);
  });

  it('4. recording skips the AI and automatic senders, and a new take-over shows up at once', async () => {
    await recordLeadHandling({ organizationId: ORG, leadId: leadFour, action: 'took_over', channel: 'sms', actor: { userId: 'ai-agent', name: 'Anna' } });
    await recordLeadHandling({ organizationId: ORG, leadId: leadFour, action: 'took_over', channel: 'sms', actor: { userId: 'system', name: 'Automation' } });
    await recordLeadHandling({ organizationId: ORG, leadId: 'bad', action: 'took_over', channel: 'sms', actor: { userId: String(beth) } });
    expect(await LeadHandlingEvent.countDocuments({ organizationId: ORG, leadId: leadFour })).toBe(0);

    expect((await leadIdsHandledBy(ORG, String(beth))).map(String)).not.toContain(String(leadFour));
    await recordLeadHandling({ organizationId: ORG, leadId: leadFour, action: 'took_over', channel: 'webchat', actor: { userId: String(beth), name: 'Beth Reyes' } });
    expect((await leadIdsHandledBy(ORG, String(beth))).map(String)).toContain(String(leadFour));
    const result = await getLeadHandlers(ORG, String(leadFour));
    expect(result.people).toHaveLength(1);
    expect(result.people[0]).toMatchObject({ name: 'Beth Reyes', roles: ['took_over'] });
  });

  it('5. the Activity list names who did each thing', async () => {
    const { items } = await buildLeadTimeline(ORG, String(leadOne), { limit: 100 });
    const find = (title: string) => items.find((item) => item.title === title);
    expect(find('Assigned to Mary Cruz')).toMatchObject({ actor: 'Beth Reyes', body: 'Before: Beth Reyes' });
    expect(find('Assigned to Beth Reyes')).toMatchObject({ actor: 'Avery Admin' });
    expect(find('Took over from the AI')).toMatchObject({ actor: 'Mary Cruz', body: 'Text messages' });
    expect(find('Turned the AI back on')).toMatchObject({ actor: 'Mary Cruz' });
    expect(find('Lead moved to Contacted')).toMatchObject({ actor: 'Beth Reyes' });
    expect(find('Email reply sent')).toMatchObject({ actor: 'Beth Reyes', channel: 'email', direction: 'outbound' });
    expect(items.find((item) => item.id.startsWith('call:') && item.direction === 'inbound')?.metadata).toMatchObject({ answeredBy: 'Mary Cruz' });
  });

  it('6. the Lead Inbox list honors the Handled by filter', async () => {
    let body: any = null;
    const res: any = {
      status() { return res; },
      json(payload: any) { body = payload; return res; },
    };
    await getAllLeads({ orgId: ORG, query: { handledBy: String(mary), limit: '50' } } as any, res);
    const leads = body?.data?.leads || body?.leads || [];
    expect(leads.map((lead: any) => String(lead._id)).sort()).toEqual([String(leadOne), String(leadThree)].sort());
  });
});
