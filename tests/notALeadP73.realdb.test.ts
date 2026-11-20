const mockSendSms = jest.fn();

jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: jest.fn() } } })));
jest.mock('googleapis', () => {
  const OAuth2 = jest.fn().mockImplementation(() => {
    const client: any = { credentials: {} };
    client.setCredentials = (credentials: any) => { client.credentials = credentials; };
    client.on = () => client;
    client.once = () => client;
    client.generateAuthUrl = () => 'https://accounts.google.com/o/oauth2/v2/auth';
    client.getToken = async () => ({ tokens: null });
    return client;
  });
  const fail = jest.fn(async () => { throw new Error('gmail is not available in tests'); });
  return {
    google: {
      gmail: jest.fn(() => ({
        users: {
          threads: { get: fail },
          messages: { get: fail, list: fail, send: fail, batchModify: fail, modify: fail },
        },
      })),
      auth: { OAuth2 },
      calendar: jest.fn(() => ({
        events: { update: jest.fn(), insert: jest.fn(), delete: jest.fn(), watch: jest.fn(async () => ({ data: {} })) },
        channels: { stop: jest.fn() },
      })),
      oauth2: jest.fn(() => ({ userinfo: { get: async () => ({ data: { email: '' } }) } })),
      drive: jest.fn(() => ({})),
      people: jest.fn(() => ({})),
    },
  };
});
jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: mockSendSms,
  verifyWebhookSignature: jest.fn(() => true),
  playMissedAndHangup: jest.fn().mockResolvedValue(undefined),
  hangupCall: jest.fn().mockResolvedValue(undefined),
  speakIvr: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
  streamLogToAdmins: jest.fn(),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/services/aiEmailReply.service', () => ({
  triggerAiEmailReplyForNewInquiry: jest.fn().mockResolvedValue(undefined),
}));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import OrgLeadConfig from '../src/models/OrgLeadConfig.model';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import CrmAutomation from '../src/models/CrmAutomation.model';
import CrmAutomationRun from '../src/models/CrmAutomationRun.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadRoutes from '../src/routes/lead.route';
import {
  getLeadStatusCounts,
  getLeadLocationCounts,
  getLeadTypeCounts,
  getAssignedNewCount,
} from '../src/controllers/lead.controller';
import { getCrmReportsOverview } from '../src/controllers/crmReports.controller';
import * as emailCampaign from '../src/controllers/emailCampaign.controller';
import * as smsCampaign from '../src/controllers/smsCampaign.controller';
import { buildSalespeopleReport } from '../src/services/crmSalespeopleReport.service';
import { loadPeriodData } from '../src/services/leaderboardStats.service';
import { runDueSteps } from '../src/services/crmAutomationEngine.service';
import { dateTriggerLeads } from '../src/services/crmAutomationSources.service';
import { resolveLeadReview } from '../src/services/leadIntakeReview.service';
import { cacheService } from '../src/services/cache.service';
import { NOT_A_LEAD_STATUS } from '../src/constants/leadStatus';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const ids = { owner: new mongoose.Types.ObjectId(), staff: new mongoose.Types.ObjectId() };
const MAILBOX = 'sales@p73-dealer.example.com';
const OLD_MAILBOX = 'old-sales@p73-dealer.example.com';
const LEAD_SOURCE_EMAIL = 'leads@dealerscloud.com';
const RUN_TAG = Date.now().toString(36);
let serial = 0;
let token = '';

const auth = () => ({ Authorization: `Bearer ${token}` });
const tag = () => `${RUN_TAG}x${++serial}`;
const nextEmail = () => `p73-${tag()}@example.com`;
const nextPhone = () => `+1801555${String(1000 + (++serial % 9000)).slice(-4)}`;
const later = () => new Date(Date.now() + 60 * 60 * 1000);
const earlier = () => new Date(Date.now() - 60 * 60 * 1000);

function callController(handler: any, req: any): Promise<{ status: number; json?: any; error?: any }> {
  return new Promise((resolve) => {
    let status = 200;
    const res: any = {
      status: (code: number) => { status = code; return res; },
      json: (body: any) => resolve({ status, json: body }),
    };
    Promise.resolve(handler({ query: {}, params: {}, body: {}, ...req }, res, (error: any) => resolve({ status: error?.statusCode || 500, error })))
      .catch((error: any) => resolve({ status: 500, error }));
  });
}

async function makeLead(org: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) {
  return Lead.create({
    organizationId: org, createdBy: ids.owner, firstName: 'Pat', lastName: `Lee${tag()}`, email: nextEmail(),
    source: 'Manual Entry', channel: 'sms', status: 'New', ...extra,
  });
}

const combined = (into: unknown) => ({ combinedInto: { leadId: into, at: new Date(), previousStatus: 'New', via: 'combine' } });

async function senders(): Promise<string[]> {
  const config: any = await OrgLeadConfig.findOne({ organizationId: orgId }).select('notLeadSenders').lean();
  return config?.notLeadSenders || [];
}

const setStatus = (leadId: unknown, body: Record<string, unknown>) =>
  request(app).patch(`/api/leads/${leadId}`).set(auth()).send(body);

describe('Real-DB: Not a Lead (Others tab) is never counted as a lead (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/_test$/.test(dbName) || mongoose.connection.host !== '127.0.0.1') {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeAudit.init(), CrmAutomationRun.init()]);
    await Organization.collection.insertOne({ _id: orgId, name: 'P73 Dealer', slug: `p73-${orgId}`, status: 'active', metadata: {} } as any);
    await User.collection.insertMany([
      { _id: ids.owner, name: 'Olivia Owner', email: `p73-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: ids.staff, name: 'Sam Staff', email: `p73-staff-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
    ] as any[]);
    await CrmUser.collection.insertOne({
      _id: ids.staff, organizationId: orgId, fullName: 'Sam Staff', username: `p73-${ids.staff}`, email: `p73-staff-${orgId}@example.com`,
      role: 'admin', isActive: true, permissions: [],
    } as any);
    await OrgLeadConfig.collection.insertOne({
      organizationId: orgId, connectedBy: ids.owner, gmailAddress: MAILBOX, accessToken: 'x', refreshToken: 'x',
      expiryDate: Date.now() + 3600000, gmailConnected: true, isActive: true, leadSourceEmail: LEAD_SOURCE_EMAIL,
      previousMailbox: { gmailAddress: OLD_MAILBOX, replacedAt: new Date() }, notLeadSenders: [],
    } as any);
    await cacheService.del(`config:org:${ORG}`);
    token = generateCrmToken(String(ids.staff));
  });

  beforeEach(() => {
    mockSendSms.mockReset();
    mockSendSms.mockResolvedValue({ id: `out-${new mongoose.Types.ObjectId()}` });
  });

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/_test$/.test(dbName) && mongoose.connection.host === '127.0.0.1') await mongoose.connection.db!.dropDatabase();
  });

  describe('a. leads list', () => {
    it('hides Not a Lead leads from the normal list and shows only them when that status or group is picked', async () => {
      const name = `Others${tag()}`;
      const fresh = await makeLead(orgId, { lastName: name, status: 'New' });
      const working = await makeLead(orgId, { lastName: name, status: 'Contacted' });
      const other = await makeLead(orgId, { lastName: name, status: NOT_A_LEAD_STATUS });
      await makeLead(orgId, { lastName: name, status: NOT_A_LEAD_STATUS, ...combined(fresh._id) });

      const plain = await request(app).get('/api/leads').query({ search: name }).set(auth());
      expect(plain.status).toBe(200);
      expect(plain.body.data.leads.map((lead: any) => String(lead._id)).sort()).toEqual([String(fresh._id), String(working._id)].sort());
      expect(plain.body.data.total).toBe(2);

      const all = await request(app).get('/api/leads').query({ search: name, status: 'All' }).set(auth());
      expect(all.body.data.leads.map((lead: any) => lead.status)).not.toContain(NOT_A_LEAD_STATUS);

      const others = await request(app).get('/api/leads').query({ search: name, status: NOT_A_LEAD_STATUS }).set(auth());
      expect(others.status).toBe(200);
      expect(others.body.data.leads.map((lead: any) => String(lead._id))).toEqual([String(other._id)]);

      const group = await request(app).get('/api/leads').query({ search: name, statusGroup: 'NotALead' }).set(auth());
      expect(group.body.data.leads.map((lead: any) => String(lead._id))).toEqual([String(other._id)]);
    });
  });

  describe('b. counts', () => {
    it('status counts still report a Not a Lead number for the Others tab but skip combined leads', async () => {
      const org = new mongoose.Types.ObjectId();
      const kept = await makeLead(org, { status: 'New' });
      await makeLead(org, { status: NOT_A_LEAD_STATUS });
      await makeLead(org, { status: NOT_A_LEAD_STATUS });
      await makeLead(org, { status: 'Closed', ...combined(kept._id) });
      const result = await callController(getLeadStatusCounts, { orgId: String(org) });
      expect(result.json.data.counts).toEqual({ New: 1, [NOT_A_LEAD_STATUS]: 2 });
    });

    it('location counts skip Not a Lead and combined leads', async () => {
      const org = new mongoose.Types.ObjectId();
      const kept = await makeLead(org, { location: 'Lehi' });
      await makeLead(org, { location: 'Lehi', status: NOT_A_LEAD_STATUS });
      await makeLead(org, { location: 'Orem', status: NOT_A_LEAD_STATUS });
      await makeLead(org, { location: 'Provo', ...combined(kept._id) });
      const result = await callController(getLeadLocationCounts, { orgId: String(org) });
      expect(result.json.data.counts).toEqual({ Lehi: 1 });
    });

    it('lead type counts skip Not a Lead and combined leads', async () => {
      const org = new mongoose.Types.ObjectId();
      const kept = await makeLead(org, { source: 'Manual Entry' });
      await makeLead(org, { source: 'Website Inquiry', channel: 'web', status: NOT_A_LEAD_STATUS });
      await makeLead(org, { source: 'Website Inquiry', channel: 'web', ...combined(kept._id) });
      await makeLead(org, { source: 'Manual Entry', status: NOT_A_LEAD_STATUS });
      const result = await callController(getLeadTypeCounts, { orgId: String(org) });
      expect(result.json.data.counts).toMatchObject({ inbound: 0, outbound: 1 });
    });

    it('the assigned to me and new count skips Not a Lead and combined leads', async () => {
      const org = new mongoose.Types.ObjectId();
      const viewer = new mongoose.Types.ObjectId();
      await User.collection.insertOne({ _id: viewer, name: 'Vic Viewer', email: `p73-viewer-${tag()}@example.com`, password: 'x', role: 'employee', organizationId: org, isActive: true } as any);
      const mine = { assignedTo: viewer, assignmentUnseenBy: viewer };
      const kept = await makeLead(org, mine);
      await makeLead(org, { ...mine, status: NOT_A_LEAD_STATUS });
      await makeLead(org, { ...mine, ...combined(kept._id) });
      const result = await callController(getAssignedNewCount, { orgId: String(org), crmUser: { _id: viewer, role: 'employee', fullName: 'Vic Viewer' } });
      expect(result.json.data.count).toBe(1);
    });
  });

  describe('c. changing a lead to and from Not a Lead', () => {
    it('saves the default reason and remembers the sender of an email inquiry', async () => {
      const sender = nextEmail();
      const lead = await makeLead(orgId, { source: 'Email Inquiry', channel: 'email', email: sender });
      const res = await setStatus(lead._id, { status: NOT_A_LEAD_STATUS });
      expect(res.status).toBe(200);
      const saved: any = await Lead.findById(lead._id).lean();
      expect(saved.status).toBe(NOT_A_LEAD_STATUS);
      expect(saved.statusHistory[saved.statusHistory.length - 1]).toMatchObject({ from: 'New', to: NOT_A_LEAD_STATUS, reason: 'Not a lead' });
      expect(await senders()).toContain(sender);
    });

    it('keeps a reason the staff member typed and does not remember senders of other lead sources', async () => {
      const sender = nextEmail();
      const lead = await makeLead(orgId, { source: 'Website Inquiry', channel: 'web', email: sender });
      expect((await setStatus(lead._id, { status: NOT_A_LEAD_STATUS, reason: 'Vendor pitch' })).status).toBe(200);
      const saved: any = await Lead.findById(lead._id).lean();
      expect(saved.statusHistory[saved.statusHistory.length - 1]).toMatchObject({ to: NOT_A_LEAD_STATUS, reason: 'Vendor pitch' });
      expect(await senders()).not.toContain(sender);
    });

    it('never remembers the lead source address or the dealership mailboxes as Not a Lead senders', async () => {
      const addresses = [LEAD_SOURCE_EMAIL, MAILBOX.toUpperCase(), OLD_MAILBOX];
      for (const email of addresses) {
        const lead = await makeLead(orgId, { source: 'Email Inquiry', channel: 'email', email });
        expect((await setStatus(lead._id, { status: NOT_A_LEAD_STATUS })).status).toBe(200);
        expect((await Lead.findById(lead._id).lean() as any).status).toBe(NOT_A_LEAD_STATUS);
      }
      const list = (await senders()).map((value) => value.toLowerCase());
      expect(list).not.toContain(LEAD_SOURCE_EMAIL);
      expect(list).not.toContain(MAILBOX);
      expect(list).not.toContain(OLD_MAILBOX);
    });

    it('moving it back to New forgets the sender, clears the excluded email flag and restores the missing thread', async () => {
      const sender = nextEmail();
      const inquiry = await LeadInquiry.collection.insertOne({
        organizationId: orgId, kind: 'provider_inquiry', receivedAt: new Date(), sourceIds: { gmailThreadId: `thread-${tag()}` },
        version: 0, createdAt: new Date(), updatedAt: new Date(),
      } as any);
      const source: any = await LeadInquiry.findById(inquiry.insertedId).lean();
      const lead = await makeLead(orgId, { source: 'Email Inquiry', channel: 'email', email: sender, sourceInquiryId: inquiry.insertedId });
      expect((await setStatus(lead._id, { status: NOT_A_LEAD_STATUS })).status).toBe(200);
      expect(await senders()).toContain(sender);
      await Lead.collection.updateOne({ _id: lead._id }, { $set: { identityEmailExcluded: true }, $unset: { threadId: 1 } });

      expect((await setStatus(lead._id, { status: 'New' })).status).toBe(200);
      const saved: any = await Lead.collection.findOne({ _id: lead._id });
      expect(saved.status).toBe('New');
      expect(saved.identityEmailExcluded).toBeUndefined();
      expect(saved.threadId).toBe(source.sourceIds.gmailThreadId);
      expect(await senders()).not.toContain(sender);
    });

    it('moving it back to New keeps a thread the lead already has', async () => {
      const sender = nextEmail();
      const inquiry = await LeadInquiry.collection.insertOne({
        organizationId: orgId, kind: 'provider_inquiry', receivedAt: new Date(), sourceIds: { gmailThreadId: `thread-${tag()}` },
        version: 0, createdAt: new Date(), updatedAt: new Date(),
      } as any);
      const lead = await makeLead(orgId, { source: 'Email Inquiry', channel: 'email', email: sender, sourceInquiryId: inquiry.insertedId, threadId: 'thread-kept' });
      expect((await setStatus(lead._id, { status: NOT_A_LEAD_STATUS })).status).toBe(200);
      await Lead.collection.updateOne({ _id: lead._id }, { $set: { identityEmailExcluded: true } });
      expect((await setStatus(lead._id, { status: 'New' })).status).toBe(200);
      const saved: any = await Lead.collection.findOne({ _id: lead._id });
      expect(saved.identityEmailExcluded).toBeUndefined();
      expect(saved.threadId).toBe('thread-kept');
    });

    it('moving it back through Pending also forgets the sender', async () => {
      const sender = nextEmail();
      const lead = await makeLead(orgId, { source: 'Email Inquiry', channel: 'email', email: sender });
      expect((await setStatus(lead._id, { status: NOT_A_LEAD_STATUS })).status).toBe(200);
      expect(await senders()).toContain(sender);
      const res = await request(app).patch(`/api/leads/${lead._id}/pending`).set(auth());
      expect(res.status).toBe(200);
      expect((await Lead.findById(lead._id).lean() as any).status).toBe('Pending');
      expect(await senders()).not.toContain(sender);
    });
  });

  describe('d. reports', () => {
    it('the CRM reports overview skips Not a Lead and combined leads', async () => {
      const org = new mongoose.Types.ObjectId();
      const kept = await makeLead(org, { source: 'Website Inquiry', channel: 'web' });
      await makeLead(org, { source: 'Website Inquiry', channel: 'web', status: NOT_A_LEAD_STATUS });
      await makeLead(org, { source: 'Website Inquiry', channel: 'web', ...combined(kept._id) });
      const result = await callController(getCrmReportsOverview, { orgId: String(org), query: { from: earlier().toISOString(), to: later().toISOString() } });
      expect(result.error).toBeUndefined();
      expect(result.json.data.leads.total).toBe(1);
      expect(result.json.data.leads.byStatus).toEqual({ New: 1 });
    });

    it('the salespeople report and leaderboard skip Not a Lead and combined leads', async () => {
      const org = new mongoose.Types.ObjectId();
      const kept = await makeLead(org, { firstName: 'Kept' });
      await makeLead(org, { firstName: 'Other', status: NOT_A_LEAD_STATUS });
      await makeLead(org, { firstName: 'Merged', ...combined(kept._id) });
      const report = await buildSalespeopleReport({ orgId: String(org), from: earlier(), to: later(), viewer: { role: 'admin' }, includeLeads: true });
      expect(report.totals.leads).toBe(1);
      expect((report.leads || []).map((row) => row.firstName)).toEqual(['Kept']);
      const period = await loadPeriodData(String(org), earlier(), later());
      expect(period.newLeads).toHaveLength(1);
    });
  });

  describe('e. campaign audiences', () => {
    it('email campaigns never include Not a Lead leads and ignore it as a status filter', async () => {
      const org = new mongoose.Types.ObjectId();
      const kept = await makeLead(org, { status: 'New' });
      await makeLead(org, { status: 'Contacted' });
      const other = await makeLead(org, { status: NOT_A_LEAD_STATUS });
      await makeLead(org, { status: 'New', ...combined(kept._id) });
      const all = await callController(emailCampaign.getAudienceCount, { orgId: String(org) });
      expect(all.json.data.count).toBe(2);
      const asked = await callController(emailCampaign.getAudienceCount, { orgId: String(org), query: { statuses: NOT_A_LEAD_STATUS } });
      expect(asked.json.data.count).toBe(2);
      expect(asked.json.data.previewRecipient?.email).not.toBe(other.email);
      const contacted = await callController(emailCampaign.getAudienceCount, { orgId: String(org), query: { statuses: `${NOT_A_LEAD_STATUS},Contacted` } });
      expect(contacted.json.data.count).toBe(1);
    });

    it('SMS campaigns never include Not a Lead leads and ignore it as a status filter', async () => {
      const org = new mongoose.Types.ObjectId();
      const kept = await makeLead(org, { phone: nextPhone(), status: 'New' });
      await makeLead(org, { phone: nextPhone(), status: 'Contacted' });
      await makeLead(org, { phone: nextPhone(), status: NOT_A_LEAD_STATUS });
      await makeLead(org, { phone: nextPhone(), status: 'New', ...combined(kept._id) });
      expect((await callController(smsCampaign.getAudienceCount, { orgId: String(org) })).json.data.count).toBe(2);
      expect((await callController(smsCampaign.getAudienceCount, { orgId: String(org), query: { statuses: NOT_A_LEAD_STATUS } })).json.data.count).toBe(2);
      expect((await callController(smsCampaign.getAudienceCount, { orgId: String(org), query: { statuses: ['Contacted', NOT_A_LEAD_STATUS] } })).json.data.count).toBe(1);
    });
  });

  describe('f. automations', () => {
    it('stops a waiting run when its lead was marked Not a Lead, before any step runs', async () => {
      const lead = await makeLead(orgId, { phone: nextPhone(), status: NOT_A_LEAD_STATUS });
      const automationId = new mongoose.Types.ObjectId();
      await CrmAutomation.collection.insertOne({
        _id: automationId, organizationId: ORG, name: `P73 ${tag()}`, status: 'active', steps: [],
        createdBy: { userId: String(ids.staff), name: 'Sam Staff' }, updatedBy: { userId: String(ids.staff), name: 'Sam Staff' },
        createdAt: new Date(), updatedAt: new Date(),
      } as any);
      const past = new Date(Date.now() - 5 * 60 * 1000);
      const run = await CrmAutomationRun.create({
        organizationId: ORG, automationId, automationName: 'P73', mode: 'live', event: 'lead_created', eventKey: `p73-${tag()}`,
        triggerAt: past, contact: { leadId: String(lead._id), name: 'Pat Lee', firstName: 'Pat', phone: lead.phone, email: lead.email },
        settings: { sendingHours: 'any_time', stopOnReply: false, cancelFirstOnReply: false, aiContinuesOnReply: false, stopOnFailure: false },
        steps: [{ id: 'step-1', type: 'send_message', config: { message: 'Hi there, reply stop to opt out' } }],
        status: 'waiting', nextRunAt: past,
      });
      await runDueSteps(new Date());
      const saved: any = await CrmAutomationRun.findById(run._id).lean();
      expect(saved).toMatchObject({ status: 'stopped', reason: 'Marked as not a lead', stepIndex: 0, nextRunAt: null });
      expect(saved.log).toHaveLength(0);
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it('date triggers skip Not a Lead and combined leads', async () => {
      const org = new mongoose.Types.ObjectId();
      const kept = await makeLead(org, { phone: nextPhone() });
      await makeLead(org, { phone: nextPhone(), status: NOT_A_LEAD_STATUS });
      await makeLead(org, { phone: nextPhone(), ...combined(kept._id) });
      const leads = await dateTriggerLeads(String(org));
      expect(leads.map((lead: any) => String(lead._id))).toEqual([String(kept._id)]);
    });
  });

  describe('g. needs review', () => {
    it('marking a possible-match chat as not a customer inquiry moves its lead to Not a Lead', async () => {
      const match = await makeLead(orgId, { phone: nextPhone(), status: 'Contacted' });
      const chatLead = await makeLead(orgId, { phone: match.phone, source: 'Website Chat', channel: 'web', firstName: 'Vera' });
      const inserted = await LeadInquiry.collection.insertOne({
        organizationId: orgId, kind: 'webchat_session', receivedAt: new Date(), sourceIds: {},
        association: { state: 'associated', leadId: chatLead._id, outcome: 'created', decidedAt: new Date() },
        review: { state: 'pending', kind: 'possible_match', candidateLeadIds: [match._id] },
        version: 0, createdAt: new Date(), updatedAt: new Date(),
      } as any);
      const result = await resolveLeadReview({
        organizationId: ORG, inquiryId: String(inserted.insertedId), resolution: 'not_customer_inquiry', actor: { userId: String(ids.staff), name: 'Sam Staff' },
      });
      expect(result.resolution).toBe('not_customer_inquiry');
      const saved: any = await Lead.findById(chatLead._id).lean();
      expect(saved.status).toBe(NOT_A_LEAD_STATUS);
      expect(saved.statusHistory[saved.statusHistory.length - 1]).toMatchObject({ from: 'New', to: NOT_A_LEAD_STATUS });
      expect((await Lead.findById(match._id).lean() as any).status).toBe('Contacted');
    });
  });
});
