const mockMessagesSend = jest.fn();
const mockSendSms = jest.fn();
const mockEmit = jest.fn();

jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn(() => ({ users: { threads: { get: jest.fn().mockResolvedValue({ data: { messages: [] } }) }, messages: { get: jest.fn(), list: jest.fn(), send: mockMessagesSend, modify: jest.fn() } } })),
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), generateAuthUrl: jest.fn(), getToken: jest.fn() })) },
    calendar: jest.fn(() => ({})),
    oauth2: jest.fn(() => ({})),
    drive: jest.fn(() => ({})),
    people: jest.fn(() => ({})),
  },
}));
jest.mock('../src/services/telnyx.service', () => {
  const actual = jest.requireActual('../src/services/telnyx.service');
  return {
    ...actual,
    COMPANY_NUMBER: '+18015550900',
    sendSms: (...args: unknown[]) => mockSendSms(...args),
    hangupCall: jest.fn().mockResolvedValue(undefined),
    answerCall: jest.fn().mockResolvedValue(undefined),
    transferToAgent: jest.fn().mockResolvedValue(undefined),
    speak: jest.fn().mockResolvedValue(undefined),
    speakIvr: jest.fn().mockResolvedValue(undefined),
    playMissedAndHangup: jest.fn().mockResolvedValue(undefined),
    verifyWebhookSignature: jest.fn(() => true),
  };
});
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: (orgId: unknown, event: string, data: unknown) => mockEmit(String(orgId), event, data),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Lead from '../src/models/lead.model';
import UserActivity from '../src/models/UserActivity.model';
import Appointment from '../src/models/Appointment.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import ComposerSendClaim from '../src/models/ComposerSendClaim.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import LeadCombineRun from '../src/models/LeadCombineRun.model';
import LeadCombineRecord from '../src/models/LeadCombineRecord.model';
import Customer from '../src/models/Customer.model';
import IntakeClaim from '../src/models/IntakeClaim.model';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadRoutes from '../src/routes/lead.route';
import communicationRoutes from '../src/routes/communication.routes';
import webchatRoutes from '../src/routes/webchat.route';
import crmWebchatRoutes from '../src/routes/crmWebchat.routes';
import { encrypt } from '../src/utils/crypto';
import { handleInboundSms, sendAutomatedSms, sendSmsFromUser, sendStaffAttributedSms } from '../src/services/communication.service';
import { notifyCustomerEmailReply } from '../src/services/orgGmail.service';
import { processGmailMessageThroughIntake } from '../src/services/gmailLeadIntake';
import { clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';
import { linkUnverifiedLead, resolveLeadReview } from '../src/services/leadIntakeReview.service';
import { runDuplicateCombine } from '../src/services/leadDuplicateCombine.service';
import { writeAiHandoff } from '../src/services/aiHandoffRouting.service';
import { markLeadAwaitingReply, moveLeadAwaitingReply, recordLeadAnswered } from '../src/utils/leadActivity';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);
app.use('/api/crm/communications', communicationRoutes);
app.use('/api/webchat', webchatRoutes);
app.use('/api/crm/webchat', crmWebchatRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const SLUG = `needsreply-${orgId}`;
const COMPANY = '+18015550900';
const LEAD_SOURCE = 'leads@dealerscloud.com';
const ids = {
  owner: new mongoose.Types.ObjectId(),
  rep: new mongoose.Types.ObjectId(),
  repCrm: new mongoose.Types.ObjectId(),
  otherCrm: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const saved = { org: process.env.COMM_ORG_ID, acceptance: process.env.LOCAL_UI_ACCEPTANCE_MODE };
let serial = 0;
const nextPhone = () => `+1801555${String(3000 + (++serial)).slice(-4)}`;
const nextEmail = () => `needsreply${++serial}@example.com`;
const nextRequestId = () => `req-${Date.now()}-${++serial}-abcdef`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const auth = (who = 'rep') => ({ Authorization: `Bearer ${tokens[who]}` });
const stored = async (id: unknown) => (await Lead.collection.findOne({ _id: new mongoose.Types.ObjectId(String(id)) })) as any;
const waitingSince = async (id: unknown) => (await stored(id))?.followUp?.awaitingReplySince ?? null;
const text = (from: string, body: string) =>
  handleInboundSms({ from, to: COMPANY, text: body, id: `sms-${new mongoose.Types.ObjectId()}` }, ORG);
const sendText = (leadId: unknown, toPhone: string, body = 'Yes, it is still here.') =>
  request(app).post('/api/crm/communications/messages').set(auth()).send({ toPhone, body, leadId: String(leadId), clientRequestId: nextRequestId() });
const sendEmail = (leadId: unknown, message = 'Thanks for writing. It is available.') =>
  request(app).post(`/api/leads/${leadId}/reply`).set(auth()).field('message', message).field('clientRequestId', nextRequestId());
const listed = async (query: Record<string, string> = {}, who = 'rep') => {
  const res = await request(app).get('/api/leads').set(auth(who)).query({ limit: '200', ...query }).expect(200);
  return res.body.data.leads as any[];
};
const needsReplyCount = async (who = 'rep') =>
  (await request(app).get('/api/leads/needs-reply-count').set(auth(who)).expect(200)).body.data.count as number;

async function makeLead(contact: { phone?: string; email?: string }, extra: Record<string, unknown> = {}, organizationId = orgId) {
  return Lead.create({
    organizationId, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', phone: contact.phone, email: contact.email,
    source: 'Website Inquiry', channel: 'web', status: 'New', subject: 'Tacoma inquiry', comments: 'Is the Tacoma available?', ...extra,
  });
}

function customerEmail(threadId: string, at: Date, from: string, headers: Array<{ name: string; value: string }> = []) {
  return {
    id: `gm-${new mongoose.Types.ObjectId()}`,
    threadId,
    internalDate: String(at.getTime()),
    snippet: 'Is it still available?',
    payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: 'Re: Tacoma inquiry' }, ...headers] },
  };
}

describe('Real-DB: leads that are waiting for a reply (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/_test$/.test(dbName) || mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    process.env.COMM_ORG_ID = ORG;
    await Promise.all([
      Lead.createIndexes(), ComposerSendClaim.init(), SmsOptOut.init(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init(),
      LeadCombineRun.init(), LeadCombineRecord.init(), Customer.init(), IntakeClaim.init(),
    ]);
    for (const index of CUSTOMER_IDENTITY_INDEXES) {
      await mongoose.connection.db!.collection(index.collection).createIndex(index.key, {
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
        ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}),
      });
    }
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Needs Reply Motors', slug: SLUG, status: 'active', metadata: { aiAgentName: 'Anna', aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } },
      { _id: otherOrgId, name: 'Other Dealer', slug: `needsreply-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertMany([
      { _id: ids.owner, name: 'Olivia Owner', email: `needsreply-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: ids.rep, name: 'Riley Rep', email: `needsreply-rep-${orgId}@example.com`, password: 'x', role: 'user', organizationRole: 'member', organizationId: orgId, isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.repCrm, organizationId: orgId, fullName: 'Riley Rep', username: `needsreply-${ids.repCrm}`, email: `needsreply-rep-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.otherCrm, organizationId: otherOrgId, fullName: 'Other Rep', username: `needsreply-${ids.otherCrm}`, email: `needsreply-other-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
    ] as any[]);
    await OrgLeadConfig.collection.insertOne({
      organizationId: orgId, connectedBy: ids.owner, gmailAddress: 'sales@needsreply.example.com', accessToken: encrypt('local-test-access'), refreshToken: encrypt('local-test-refresh'),
      expiryDate: Date.now() + 3600000, gmailConnected: true, isActive: true, leadSourceEmail: LEAD_SOURCE,
    } as any);
    tokens.rep = generateCrmToken(String(ids.repCrm));
    tokens.other = generateCrmToken(String(ids.otherCrm));
  });

  beforeEach(() => {
    mockSendSms.mockReset();
    mockSendSms.mockImplementation(async () => ({ id: `tx-${++serial}` }));
    mockMessagesSend.mockReset();
    mockMessagesSend.mockImplementation(async () => ({ data: { id: `gm-${++serial}`, threadId: `th-${serial}` } }));
    mockEmit.mockClear();
  });

  afterAll(async () => {
    if (saved.org === undefined) delete process.env.COMM_ORG_ID;
    else process.env.COMM_ORG_ID = saved.org;
    if (saved.acceptance === undefined) delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
    else process.env.LOCAL_UI_ACCEPTANCE_MODE = saved.acceptance;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/_test$/.test(dbName) && mongoose.connection.host === '127.0.0.1') await mongoose.connection.db!.dropDatabase();
  });

  describe('texts', () => {
    it('marks the lead when the customer texts and keeps the time of the first text that has no answer', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      expect(await waitingSince(lead._id)).toBeNull();

      const before = Date.now();
      await text(phone, 'Is the Tacoma still available?');
      const first = await waitingSince(lead._id);
      expect(first).toBeInstanceOf(Date);
      expect(first.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(mockEmit).toHaveBeenCalledWith(ORG, 'lead:update', { leadId: String(lead._id) });

      await wait(20);
      await text(phone, 'Hello?');
      expect((await waitingSince(lead._id)).getTime()).toBe(first.getTime());

      const row = (await listed()).find((item) => String(item._id) === String(lead._id));
      expect(new Date(row.needsReplySince).getTime()).toBe(first.getTime());
      const single = await request(app).get(`/api/leads/${lead._id}`).set(auth()).expect(200);
      expect(new Date(single.body.data.needsReplySince).getTime()).toBe(first.getTime());
    });

    it('clears it when a team member texts back, without touching the time the follow-up jobs read', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Can I come see it today?');
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);

      mockEmit.mockClear();
      await sendText(lead._id, phone).expect(201);

      const after = await stored(lead._id);
      expect(after.followUp?.awaitingReplySince).toBeUndefined();
      expect(after.followUp?.lastAnsweredAt).toBeInstanceOf(Date);
      expect(after.followUp?.lastRepResponseAt ?? null).toBeNull();
      expect(mockEmit).toHaveBeenCalledWith(ORG, 'lead:update', { leadId: String(lead._id) });
      const row = (await listed()).find((item) => String(item._id) === String(lead._id));
      expect(row.needsReplySince).toBeNull();
    });

    it('marks it again when the customer writes after our answer', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'What is the price?');
      const first = await waitingSince(lead._id);
      await sendText(lead._id, phone, 'It is $24,900.').expect(201);
      expect(await waitingSince(lead._id)).toBeNull();

      await wait(20);
      await text(phone, 'Can you do better?');
      const second = await waitingSince(lead._id);
      expect(second).toBeInstanceOf(Date);
      expect(second.getTime()).toBeGreaterThan(first.getTime());
    });

    it('keeps it when the text could not be sent', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Are you open on Sunday?');
      mockSendSms.mockRejectedValueOnce(Object.assign(new Error('Invalid destination number'), { status: 400 }));
      await sendText(lead._id, phone).expect(502);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
      expect((await stored(lead._id)).followUp?.lastAnsweredAt ?? null).toBeNull();
    });

    it('keeps it after an automatic text, a campaign text and an AI follow-up', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Do you take trade-ins?');
      const since = await waitingSince(lead._id);

      expect(await sendAutomatedSms({ orgId: ORG, toPhone: phone, body: 'Sorry we missed your call.', leadId: lead._id })).toBe(true);
      expect(await sendStaffAttributedSms({ orgId: ORG, toPhone: phone, body: 'Price drop this week!', leadId: lead._id, actor: { userId: String(ids.rep), name: 'Riley Rep' } })).toBeTruthy();
      await sendSmsFromUser({ orgId: ORG, user: { userId: 'ai-agent', name: 'Anna' }, toPhone: phone, body: 'Just checking in.', leadId: lead._id, answersCustomer: false });

      expect(mockSendSms).toHaveBeenCalledTimes(3);
      expect((await waitingSince(lead._id)).getTime()).toBe(since.getTime());
      expect((await stored(lead._id)).followUp?.lastAnsweredAt ?? null).toBeNull();
    });

    it('clears it when the assistant really sends an answer to the customer', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Is it automatic?');
      await sendSmsFromUser({ orgId: ORG, user: { userId: 'ai-agent', name: 'Anna' }, toPhone: phone, body: 'Yes, it is automatic.', leadId: lead._id, answersCustomer: true });
      expect(await waitingSince(lead._id)).toBeNull();
      expect((await stored(lead._id)).followUp?.lastAnsweredAt).toBeInstanceOf(Date);
    });

    it('marks it again when the assistant hands the customer over to a person', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Can you beat this other offer?');
      await sendSmsFromUser({
        orgId: ORG, user: { userId: 'ai-agent', name: 'Anna' }, toPhone: phone, leadId: lead._id, answersCustomer: true,
        body: 'Thanks for your message! A member of our team will follow up with you shortly.',
      });
      expect(await waitingSince(lead._id)).toBeNull();

      await writeAiHandoff({ organizationId: ORG, leadId: String(lead._id), channel: 'sms', reason: 'Pricing question', agentName: 'Anna', customerName: 'Pat Lee' });
      const after = await stored(lead._id);
      expect(after.followUp?.awaitingReplySince).toBeInstanceOf(Date);
      expect(after.followUp.awaitingReplySince.getTime()).toBeGreaterThanOrEqual(after.followUp.lastAnsweredAt.getTime());
    });

    it('works the same when the newer lead matching is on', async () => {
      const matchOrg = new mongoose.Types.ObjectId();
      const MATCH = String(matchOrg);
      await Organization.collection.insertOne({
        _id: matchOrg, name: 'Matching Dealer', slug: `needsreply-match-${matchOrg}`, status: 'active',
        metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } },
      } as any);
      await User.collection.insertOne({ organizationId: matchOrg, name: 'Avery Admin', email: `needsreply-match-${matchOrg}@example.com`, role: 'admin', organizationRole: 'admin', isActive: true } as any);
      await LeadIntakeControl.collection.insertOne({ organizationId: matchOrg, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
      clearLeadIntakeModeCache(MATCH);
      const send = (from: string, body: string) => handleInboundSms({ from, to: COMPANY, text: body, id: `sms-${new mongoose.Types.ObjectId()}` }, MATCH);

      const phone = nextPhone();
      const lead = await makeLead({ phone }, {}, matchOrg);
      await send(phone, 'Is the Tacoma still available?');
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
      expect(await Lead.countDocuments({ organizationId: matchOrg, normalizedPhone: phone })).toBe(1);

      const quiet = nextPhone();
      const quietLead = await makeLead({ phone: quiet }, {}, matchOrg);
      await send(quiet, 'STOP');
      await send(quiet, 'HELP');
      expect(await waitingSince(quietLead._id)).toBeNull();

      const stranger = nextPhone();
      await send(stranger, 'Hi, do you have any SUVs?');
      let created: any = null;
      for (let attempt = 0; attempt < 60 && !created; attempt += 1) {
        created = await Lead.findOne({ organizationId: matchOrg, normalizedPhone: stranger }).lean();
        if (!created) await wait(100);
      }
      expect(created).toBeTruthy();
      expect(created.followUp?.awaitingReplySince).toBeInstanceOf(Date);
    });

    it('marks a first-time texter who has no lead yet', async () => {
      const phone = nextPhone();
      await text(phone, 'Hi, do you have any trucks under 20k?');
      const lead: any = await Lead.findOne({ organizationId: orgId, normalizedPhone: phone }).lean();
      expect(lead).toBeTruthy();
      expect(lead.followUp?.awaitingReplySince).toBeInstanceOf(Date);
    });

    it('does not mark STOP, and leaves an earlier question that has no answer', async () => {
      const quiet = nextPhone();
      const quietLead = await makeLead({ phone: quiet });
      await text(quiet, 'STOP');
      expect(await waitingSince(quietLead._id)).toBeNull();

      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'What are your hours?');
      const since = await waitingSince(lead._id);
      await wait(20);
      await text(phone, 'STOP');
      expect((await waitingSince(lead._id)).getTime()).toBe(since.getTime());
    });

    it('does not mark a YES to an appointment reminder, and leaves an earlier question that has no answer', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Do you have it in blue?');
      const since = await waitingSince(lead._id);
      const appointment = await Appointment.collection.insertOne({
        organizationId: ORG, leadId: lead._id, title: 'Test drive', entryType: 'appointment', status: 'scheduled',
        startTime: new Date(Date.now() + 3600000), endTime: new Date(Date.now() + 7200000),
        reminderSent: true, reminderSentAt: new Date(), customerBooking: { phone, firstName: 'Pat' },
      } as any);

      await wait(20);
      await text(phone, 'YES');
      expect((await Appointment.findById(appointment.insertedId).lean() as any)?.status).toBe('confirmed');
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect((await waitingSince(lead._id)).getTime()).toBe(since.getTime());

      const fresh = nextPhone();
      const freshLead = await makeLead({ phone: fresh });
      await Appointment.collection.insertOne({
        organizationId: ORG, leadId: freshLead._id, title: 'Test drive', entryType: 'appointment', status: 'scheduled',
        startTime: new Date(Date.now() + 3600000), endTime: new Date(Date.now() + 7200000),
        reminderSent: true, reminderSentAt: new Date(), customerBooking: { phone: fresh, firstName: 'Pat' },
      } as any);
      await text(fresh, 'YES');
      expect(await waitingSince(freshLead._id)).toBeNull();
    });

    it('marks the lead when the customer names a new appointment time, because the team still has to confirm it', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await Appointment.collection.insertOne({
        organizationId: ORG, leadId: lead._id, title: 'Test drive', entryType: 'appointment', status: 'scheduled',
        startTime: new Date(Date.now() + 3600000), endTime: new Date(Date.now() + 7200000),
        rescheduleAwaitingReplyAt: new Date(), customerBooking: { phone, firstName: 'Pat' },
      } as any);
      await text(phone, 'Friday at 3pm works');
      expect(mockSendSms).toHaveBeenCalledTimes(1);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
    });
  });

  describe('email', () => {
    it('marks the lead for an email the customer wrote, and clears it when a team member emails back', async () => {
      const email = nextEmail();
      const threadId = `th-${new mongoose.Types.ObjectId()}`;
      const lead = await makeLead({ email }, { threadId, channel: 'email' });
      await wait(20);
      const at = new Date();

      expect(await notifyCustomerEmailReply(ORG, customerEmail(threadId, at, `Pat Lee <${email}>`), LEAD_SOURCE)).toBe(true);
      expect((await waitingSince(lead._id)).getTime()).toBe(at.getTime());

      await sendEmail(lead._id).expect(200);
      expect(mockMessagesSend).toHaveBeenCalledTimes(1);
      const after = await stored(lead._id);
      expect(after.followUp?.awaitingReplySince).toBeUndefined();
      expect(after.followUp?.lastAnsweredAt).toBeInstanceOf(Date);
      expect(after.followUp?.lastRepResponseAt).toBeInstanceOf(Date);
    });

    it('does not mark a lead email from the lead feed or an automatic reply', async () => {
      const feedThread = `th-${new mongoose.Types.ObjectId()}`;
      const feedLead = await makeLead({ email: nextEmail() }, { threadId: feedThread, channel: 'email' });
      await notifyCustomerEmailReply(ORG, customerEmail(feedThread, new Date(), `Dealer Feed <${LEAD_SOURCE}>`), LEAD_SOURCE);
      expect(await waitingSince(feedLead._id)).toBeNull();
      expect((await stored(feedLead._id)).followUp?.lastCustomerActivityAt).toBeInstanceOf(Date);

      const email = nextEmail();
      const autoThread = `th-${new mongoose.Types.ObjectId()}`;
      const autoLead = await makeLead({ email }, { threadId: autoThread, channel: 'email' });
      await notifyCustomerEmailReply(ORG, customerEmail(autoThread, new Date(), `Pat Lee <${email}>`, [{ name: 'Auto-Submitted', value: 'auto-replied' }]), LEAD_SOURCE);
      expect(await waitingSince(autoLead._id)).toBeNull();

      const intakeOrg = new mongoose.Types.ObjectId();
      await Organization.collection.insertOne({ _id: intakeOrg, name: 'Away Dealer', slug: `needsreply-away-${intakeOrg}`, status: 'active', metadata: {} } as any);
      await LeadIntakeControl.collection.insertOne({ organizationId: intakeOrg, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
      clearLeadIntakeModeCache(String(intakeOrg));
      const awayThread = `th-${new mongoose.Types.ObjectId()}`;
      const awayLead = await makeLead({ email }, { threadId: awayThread, channel: 'email' }, intakeOrg);
      const away = customerEmail(awayThread, new Date(), `Pat Lee <${email}>`);
      away.payload.headers = [{ name: 'From', value: `Pat Lee <${email}>` }, { name: 'Subject', value: 'Automatic reply: Tacoma inquiry' }];
      const bounce = customerEmail(awayThread, new Date(), 'Mail Delivery Subsystem <mailer-daemon@example.com>');
      for (const message of [away, bounce]) {
        const result = await processGmailMessageThroughIntake({
          organizationId: String(intakeOrg), message, rawBody: 'I am out of the office until Monday.', leadSourceEmail: LEAD_SOURCE,
          systemUserId: String(ids.owner), allowNewInquiry: false,
        });
        expect(result.status).toBe('dismissed');
        await notifyCustomerEmailReply(String(intakeOrg), message, LEAD_SOURCE, true);
      }
      expect(await waitingSince(awayLead._id)).toBeNull();
    });

    it('does not mark the email that started the lead, only later emails from the customer', async () => {
      const email = nextEmail();
      const threadId = `th-${new mongoose.Types.ObjectId()}`;
      const first = customerEmail(threadId, new Date(), `Pat Lee <${email}>`);
      const lead = await makeLead({ email }, { threadId, channel: 'email', messageId: first.id });
      await wait(20);
      first.internalDate = String(Date.now());
      await notifyCustomerEmailReply(ORG, first, LEAD_SOURCE);
      expect(await waitingSince(lead._id)).toBeNull();

      await wait(20);
      await notifyCustomerEmailReply(ORG, customerEmail(threadId, new Date(), `Pat Lee <${email}>`), LEAD_SOURCE);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
    });

    it('checking the same email again after the lead was marked Sold does not bring the mark back', async () => {
      const email = nextEmail();
      const threadId = `th-${new mongoose.Types.ObjectId()}`;
      const lead = await makeLead({ email }, { threadId, channel: 'email' });
      await wait(20);
      const message = customerEmail(threadId, new Date(), `Pat Lee <${email}>`);
      await notifyCustomerEmailReply(ORG, message, LEAD_SOURCE);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);

      await wait(20);
      await request(app).patch(`/api/leads/${lead._id}`).set(auth()).send({ status: 'Sold' }).expect(200);
      await notifyCustomerEmailReply(ORG, message, LEAD_SOURCE);
      expect(await waitingSince(lead._id)).toBeNull();
    });

    it('does not mark an older email that arrives after we already answered', async () => {
      const email = nextEmail();
      const threadId = `th-${new mongoose.Types.ObjectId()}`;
      const lead = await makeLead({ email }, { threadId, channel: 'email' });
      const late = new Date(Date.now() - 10 * 60000);
      await Lead.collection.updateOne({ _id: lead._id }, { $set: { 'followUp.lastCustomerActivityAt': new Date(Date.now() - 20 * 60000) } });
      await recordLeadAnswered(lead._id, ORG, new Date(Date.now() - 5 * 60000));
      await notifyCustomerEmailReply(ORG, customerEmail(threadId, late, `Pat Lee <${email}>`), LEAD_SOURCE);
      const after = await stored(lead._id);
      expect(after.followUp.lastCustomerActivityAt.getTime()).toBe(late.getTime());
      expect(after.followUp.awaitingReplySince).toBeUndefined();
    });

    it('marks an email whose time was already saved on the lead, and checking the same email again after our answer changes nothing', async () => {
      const email = nextEmail();
      const threadId = `th-${new mongoose.Types.ObjectId()}`;
      const lead = await makeLead({ email }, { threadId, channel: 'email' });
      await wait(20);
      const at = new Date();
      await Lead.collection.updateOne({ _id: lead._id }, { $set: { 'followUp.lastCustomerActivityAt': at } });
      const message = customerEmail(threadId, at, `Pat Lee <${email}>`);

      await notifyCustomerEmailReply(ORG, message, LEAD_SOURCE);
      expect((await waitingSince(lead._id)).getTime()).toBe(at.getTime());

      await wait(20);
      await sendEmail(lead._id).expect(200);
      expect(await waitingSince(lead._id)).toBeNull();
      await notifyCustomerEmailReply(ORG, message, LEAD_SOURCE);
      expect(await waitingSince(lead._id)).toBeNull();
    });

    it('checking the same email again after "No reply needed" does not bring the mark back', async () => {
      const email = nextEmail();
      const threadId = `th-${new mongoose.Types.ObjectId()}`;
      const lead = await makeLead({ email }, { threadId, channel: 'email' });
      await wait(20);
      const message = customerEmail(threadId, new Date(), `Pat Lee <${email}>`);
      await notifyCustomerEmailReply(ORG, message, LEAD_SOURCE);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);

      await wait(20);
      await request(app).patch(`/api/leads/${lead._id}/no-reply-needed`).set(auth()).expect(200);
      await notifyCustomerEmailReply(ORG, message, LEAD_SOURCE);
      expect(await waitingSince(lead._id)).toBeNull();
    });

    it('marks a customer email reply that comes in through lead intake', async () => {
      const intakeOrg = new mongoose.Types.ObjectId();
      await Organization.collection.insertOne({
        _id: intakeOrg, name: 'Intake Dealer', slug: `needsreply-intake-${intakeOrg}`, status: 'active',
        metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } },
      } as any);
      await LeadIntakeControl.collection.insertOne({ organizationId: intakeOrg, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
      clearLeadIntakeModeCache(String(intakeOrg));
      const email = nextEmail();
      const threadId = `th-${new mongoose.Types.ObjectId()}`;
      const lead = await makeLead({ email }, { threadId, channel: 'email' }, intakeOrg);
      await wait(20);
      const at = new Date();
      const message = customerEmail(threadId, at, `Pat Lee <${email}>`);

      const result = await processGmailMessageThroughIntake({
        organizationId: String(intakeOrg), message, rawBody: 'Is it still available?', leadSourceEmail: LEAD_SOURCE,
        systemUserId: String(ids.owner), allowNewInquiry: false,
      });
      expect(result.status).toBe('associated');
      expect((await stored(lead._id)).followUp.lastCustomerActivityAt.getTime()).toBe(at.getTime());
      expect((await waitingSince(lead._id)).getTime()).toBe(at.getTime());

      await notifyCustomerEmailReply(String(intakeOrg), message, LEAD_SOURCE, true);
      expect((await waitingSince(lead._id)).getTime()).toBe(at.getTime());
    });

    it('marks an email that lead intake sends to Needs review only on the lead that staff picks', async () => {
      const intakeOrg = new mongoose.Types.ObjectId();
      const INTAKE = String(intakeOrg);
      await Organization.collection.insertOne({
        _id: intakeOrg, name: 'Review Dealer', slug: `needsreply-review-${intakeOrg}`, status: 'active',
        metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } },
      } as any);
      await LeadIntakeControl.collection.insertOne({ organizationId: intakeOrg, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
      clearLeadIntakeModeCache(INTAKE);
      const threadId = `th-${new mongoose.Types.ObjectId()}`;
      const lead = await makeLead({ email: nextEmail() }, { threadId, channel: 'email' }, intakeOrg);
      await wait(20);
      const at = new Date();
      const message = customerEmail(threadId, at, `Loan Officer <${nextEmail()}>`);

      const result = await processGmailMessageThroughIntake({
        organizationId: INTAKE, message, rawBody: 'Approval attached for your customer.', leadSourceEmail: LEAD_SOURCE,
        systemUserId: String(ids.owner), allowNewInquiry: false,
      });
      expect(result.status).toBe('review');
      await notifyCustomerEmailReply(INTAKE, message, LEAD_SOURCE, true);
      expect(await waitingSince(lead._id)).toBeNull();

      await resolveLeadReview({
        organizationId: INTAKE, inquiryId: (result as any).inquiryId, resolution: 'associate', leadId: String(lead._id),
        actor: { userId: String(ids.repCrm), name: 'Riley Rep' },
      });
      expect((await waitingSince(lead._id)).getTime()).toBe(at.getTime());
    });
  });

  describe('web chat', () => {
    it('marks the lead for a web chat message and clears it when a team member replies in the chat', async () => {
      const phone = nextPhone();
      const started = await request(app).post('/api/webchat/public/sessions').send({ orgKey: SLUG, name: 'Pat Visitor', phone, message: 'Is the Camry still for sale?' });
      expect(started.status).toBe(201);
      const { sessionId, token } = started.body.data;
      const lead: any = await Lead.findOne({ organizationId: orgId, normalizedPhone: phone }).lean();
      expect(lead.followUp?.awaitingReplySince).toBeInstanceOf(Date);

      await request(app).post(`/api/crm/webchat/leads/${lead._id}/messages`).set(auth()).send({ body: 'Yes it is. Want to come see it?' }).expect(201);
      expect(await waitingSince(lead._id)).toBeNull();

      await wait(20);
      await request(app).post(`/api/webchat/public/sessions/${sessionId}/messages`).send({ token, message: 'Yes, tomorrow morning.' }).expect(201);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
    });
  });

  describe('calls, status and notes', () => {
    it('keeps it while a call to the customer is only ringing, and clears it when the call connects', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Please call me.');
      const clientCallId = `cc_p68_${Date.now()}_${++serial}`;
      const logCall = (body: Record<string, unknown>) => request(app).post('/api/crm/communications/calls/log').set(auth()).send(body);

      await logCall({ clientCallId, event: 'start', toPhone: phone, leadId: String(lead._id) }).expect(200);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
      expect((await stored(lead._id)).followUp?.lastAnsweredAt ?? null).toBeNull();

      await logCall({ clientCallId, event: 'answered' }).expect(200);
      expect(await waitingSince(lead._id)).toBeNull();
      expect((await stored(lead._id)).followUp?.lastAnsweredAt).toBeInstanceOf(Date);
      await logCall({ clientCallId, event: 'end' }).expect(200);
    });

    it('keeps it when a call to the customer fails or is not picked up', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Call me when you can.');
      const clientCallId = `cc_p68_${Date.now()}_${++serial}`;
      const logCall = (body: Record<string, unknown>) => request(app).post('/api/crm/communications/calls/log').set(auth()).send(body);
      await logCall({ clientCallId, event: 'start', toPhone: phone, leadId: String(lead._id) }).expect(200);
      await logCall({ clientCallId, event: 'end' }).expect(200);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
    });

    it('clears it when the status is changed to Contacted, and keeps it after a note', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Any update?');

      await request(app).post(`/api/leads/${lead._id}/notes`).set(auth()).send({ note: 'Left a message with the manager.' }).expect(201);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);

      await request(app).patch(`/api/leads/${lead._id}`).set(auth()).send({ status: 'Contacted' }).expect(200);
      expect(await waitingSince(lead._id)).toBeNull();
    });

    it('clears it when the lead is moved to a finished status, so reopening it later does not bring an old mark back', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'We bought somewhere else.');
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);

      await request(app).patch(`/api/leads/${lead._id}`).set(auth()).send({ status: 'Bought Elsewhere' }).expect(200);
      const finished = await stored(lead._id);
      expect(finished.followUp?.awaitingReplySince).toBeUndefined();
      expect(finished.followUp?.lastRepResponseAt ?? null).toBeNull();

      await request(app).patch(`/api/leads/${lead._id}`).set(auth()).send({ status: 'New' }).expect(200);
      expect(await waitingSince(lead._id)).toBeNull();
      expect((await listed({ needsReply: 'true' })).map((item) => String(item._id))).not.toContain(String(lead._id));

      await wait(20);
      await text(phone, 'Actually, is the truck still there?');
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
    });
  });

  describe('leads that are joined together', () => {
    it('moves the mark to the lead that stays, unless that lead was answered later', async () => {
      const since = new Date(Date.now() - 20 * 60000);
      const from = await makeLead({ phone: nextPhone() });
      const to = await makeLead({ phone: nextPhone() });
      await Lead.collection.updateOne({ _id: from._id }, { $set: { 'followUp.awaitingReplySince': since } });
      await moveLeadAwaitingReply([from._id], to._id, ORG);
      expect(await waitingSince(from._id)).toBeNull();
      expect((await waitingSince(to._id)).getTime()).toBe(since.getTime());

      const other = await makeLead({ phone: nextPhone() });
      const answered = await makeLead({ phone: nextPhone() });
      await Lead.collection.updateOne({ _id: other._id }, { $set: { 'followUp.awaitingReplySince': since } });
      await recordLeadAnswered(answered._id, ORG, new Date(Date.now() - 5 * 60000));
      await moveLeadAwaitingReply([other._id], answered._id, ORG);
      expect(await waitingSince(other._id)).toBeNull();
      expect(await waitingSince(answered._id)).toBeNull();

      const calm = await makeLead({ phone: nextPhone() });
      const target = await makeLead({ phone: nextPhone() });
      await moveLeadAwaitingReply([calm._id], target._id, ORG);
      expect(await waitingSince(target._id)).toBeNull();
    });

    it('keeps the mark when a web chat lead is linked to the customer\'s existing lead', async () => {
      const phone = nextPhone();
      const started = await request(app).post('/api/webchat/public/sessions').send({ orgKey: SLUG, name: 'Pat Visitor', phone, message: 'Do you have the Camry in white?' });
      expect(started.status).toBe(201);
      const chatLead: any = await Lead.findOne({ organizationId: orgId, normalizedPhone: phone }).lean();
      const since = chatLead.followUp.awaitingReplySince;
      expect(since).toBeInstanceOf(Date);
      await Lead.collection.updateOne({ _id: chatLead._id }, { $set: { intakeIdentity: 'unverified' } });
      const existing = await makeLead({ phone: nextPhone() }, { createdAt: new Date(Date.now() - 86400000) });

      await linkUnverifiedLead({ organizationId: ORG, leadId: String(chatLead._id), targetLeadId: String(existing._id), actor: { userId: String(ids.repCrm), name: 'Riley Rep' } });

      expect((await waitingSince(existing._id)).getTime()).toBe(since.getTime());
      expect(await waitingSince(chatLead._id)).toBeNull();
      const rows = await listed({ needsReply: 'true' });
      expect(rows.map((item) => String(item._id))).toContain(String(existing._id));
      expect(rows.map((item) => String(item._id))).not.toContain(String(chatLead._id));
    });

    it('moves the mark to the lead that stays when duplicate leads are combined', async () => {
      const dupOrg = new mongoose.Types.ObjectId();
      await Organization.collection.insertOne({ _id: dupOrg, name: 'Combine Dealer', slug: `needsreply-combine-${dupOrg}`, status: 'active', metadata: {} } as any);
      const phone = nextPhone();
      const since = new Date(Date.now() - 30 * 60000);
      const older = await makeLead({ phone }, { createdAt: new Date(Date.now() - 2 * 86400000) }, dupOrg);
      const newer = await makeLead({ phone }, { createdAt: new Date(Date.now() - 86400000) }, dupOrg);
      await Lead.collection.updateOne({ _id: older._id }, { $set: { 'followUp.awaitingReplySince': since } });
      await LeadIntakeControl.collection.insertOne({ organizationId: dupOrg, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
      clearLeadIntakeModeCache(String(dupOrg));

      const stats: any = await runDuplicateCombine(String(dupOrg));
      expect(stats).toMatchObject({ leadsCombined: 1 });
      expect((await stored(older._id)).combinedInto?.leadId?.toString()).toBe(String(newer._id));
      expect((await waitingSince(newer._id)).getTime()).toBe(since.getTime());
      expect(await waitingSince(older._id)).toBeNull();
    });
  });

  describe('No reply needed', () => {
    it('clears the mark, records who did it, and does nothing the second time', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'Thanks, see you Friday!');

      await request(app).patch(`/api/leads/${lead._id}/no-reply-needed`).set(auth('other')).expect(404);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);

      const done = await request(app).patch(`/api/leads/${lead._id}/no-reply-needed`).set(auth()).expect(200);
      expect(done.body.data).toMatchObject({ leadId: String(lead._id), needsReply: false });
      const after = await stored(lead._id);
      expect(after.followUp?.awaitingReplySince).toBeUndefined();
      expect(after.followUp?.lastAnsweredAt).toBeInstanceOf(Date);
      const logged = { 'metadata.leadId': String(lead._id), 'metadata.activityKind': 'lead_no_reply_needed' };
      expect(await UserActivity.countDocuments(logged)).toBe(1);

      await request(app).patch(`/api/leads/${lead._id}/no-reply-needed`).set(auth()).expect(200);
      expect(await UserActivity.countDocuments(logged)).toBe(1);
    });
  });

  describe('list, filter and count', () => {
    it('lists only open leads that are waiting, and counts the ones assigned to the person asking', async () => {
      const mine = nextPhone();
      const theirs = nextPhone();
      const closed = nextPhone();
      const answered = nextPhone();
      const mineLead = await makeLead({ phone: mine }, { assignedTo: ids.rep });
      const theirLead = await makeLead({ phone: theirs }, { assignedTo: ids.owner });
      const closedLead = await makeLead({ phone: closed }, { assignedTo: ids.rep });
      const answeredLead = await makeLead({ phone: answered }, { assignedTo: ids.rep });
      const countBefore = await needsReplyCount();

      await text(mine, 'Is it still there?');
      await text(theirs, 'Is it still there?');
      await text(closed, 'Is it still there?');
      await text(answered, 'Is it still there?');
      await sendText(answeredLead._id, answered).expect(201);
      await Lead.collection.updateOne({ _id: closedLead._id }, { $set: { status: 'Closed' } });

      const waiting = (await listed({ needsReply: 'true' })).map((item) => String(item._id));
      expect(waiting).toEqual(expect.arrayContaining([String(mineLead._id), String(theirLead._id)]));
      expect(waiting).not.toContain(String(closedLead._id));
      expect(waiting).not.toContain(String(answeredLead._id));

      const closedRow = (await listed({ status: 'Closed' })).find((item) => String(item._id) === String(closedLead._id));
      expect(closedRow.needsReplySince).toBeNull();
      expect(await waitingSince(closedLead._id)).toBeInstanceOf(Date);

      const mineOnly = (await listed({ needsReply: 'true', assignedTo: String(ids.rep) })).map((item) => String(item._id));
      expect(mineOnly).toContain(String(mineLead._id));
      expect(mineOnly).not.toContain(String(theirLead._id));

      expect(await needsReplyCount()).toBe(countBefore + 1);
      expect(await needsReplyCount('other')).toBe(0);
    });

    it('puts a lead we already texted back below the ones still waiting in Longest waiting', async () => {
      const waitingPhone = nextPhone();
      const answeredPhone = nextPhone();
      const tag = `sort-${new mongoose.Types.ObjectId()}`;
      const answeredLead = await makeLead({ phone: answeredPhone }, { lastName: tag });
      const waitingLead = await makeLead({ phone: waitingPhone }, { lastName: tag });
      await text(answeredPhone, 'First question');
      await wait(20);
      await text(waitingPhone, 'Second question');
      await sendText(answeredLead._id, answeredPhone).expect(201);

      const order = (await listed({ sortBy: 'waiting_longest', search: tag })).map((item) => String(item._id));
      expect(order).toEqual([String(waitingLead._id), String(answeredLead._id)]);
    });
  });

  describe('timing', () => {
    it('keeps the mark when the answer is older than the last message from the customer', async () => {
      const phone = nextPhone();
      const lead = await makeLead({ phone });
      await text(phone, 'One more thing...');
      await recordLeadAnswered(lead._id, ORG, new Date(Date.now() - 10 * 60000));
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
    });

    it('does not mark a message that is older than our last answer', async () => {
      const lead = await makeLead({ phone: nextPhone() });
      await recordLeadAnswered(lead._id, ORG, new Date(Date.now() - 5 * 60000));
      await markLeadAwaitingReply(lead._id, new Date(Date.now() - 10 * 60000), ORG);
      expect(await waitingSince(lead._id)).toBeNull();
      await markLeadAwaitingReply(lead._id, new Date(), ORG);
      expect(await waitingSince(lead._id)).toBeInstanceOf(Date);
    });

    it('ignores ids that are not leads', async () => {
      await expect(markLeadAwaitingReply('not-an-id')).resolves.toBeUndefined();
      await expect(recordLeadAnswered(undefined, ORG)).resolves.toBeUndefined();
    });
  });
});
