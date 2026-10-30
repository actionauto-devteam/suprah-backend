const mockSendSms = jest.fn();
const mockMessagesSend = jest.fn();
const mockGenerateReply = jest.fn();
const mockGenerateEmailReply = jest.fn();
const mockClassify = jest.fn();
const mockClassifyEmail = jest.fn();

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
jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: (...args: unknown[]) => mockSendSms(...args),
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
  streamLogToAdmins: jest.fn(),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/utils/aiOutboundSafety', () => ({
  ...jest.requireActual('../src/utils/aiOutboundSafety'),
  hasGeminiApiKey: () => true,
}));
jest.mock('../src/services/aiAgent.service', () => ({
  ...jest.requireActual('../src/services/aiAgent.service'),
  generateAlexReply: (...args: unknown[]) => mockGenerateReply(...args),
  generateAlexEmailReply: (...args: unknown[]) => mockGenerateEmailReply(...args),
  classifyAlexReplySafety: (...args: unknown[]) => mockClassify(...args),
  classifyAlexEmailReplySafety: (...args: unknown[]) => mockClassifyEmail(...args),
}));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import AiAgentLog from '../src/models/AiAgentLog.model';
import AiUsageCounter from '../src/models/AiUsageCounter.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import { CommunicationMessage, Conversation } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadRoutes from '../src/routes/lead.route';
import { clearLeadIntakeModeCache, setLeadIntakeMode } from '../src/services/leadIntakeControl.service';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);
app.use((error: any, _req: any, res: any, _next: any) =>
  res.status(error.statusCode || 500).json({ message: error.message, errors: error.errors }));

const orgId = new mongoose.Types.ObjectId();
const unnamedOrgId = new mongoose.Types.ObjectId();
const offOrgId = new mongoose.Types.ObjectId();
const OFF_METADATA = { aiAgentName: 'Riley', aiAgentEnabled: false, aiShadowDraftsEnabled: false, aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } };
const ids = {
  owner: new mongoose.Types.ObjectId(),
  employee: new mongoose.Types.ObjectId(),
  unnamedEmployee: new mongoose.Types.ObjectId(),
  offEmployee: new mongoose.Types.ObjectId(),
  limited: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const pausedAt = new Date('2026-10-24T12:00:00Z');
let serial = 0;
const nextPhone = () => `+1801555${String(8000 + (++serial)).slice(-4)}`;
const savedSkip = process.env.SKIP_RATE_LIMIT;

const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const draft = (leadId: unknown, channel: string, who = 'employee') =>
  request(app).post(`/api/leads/${leadId}/ai-draft`).set(auth(who)).send({ channel });
const codeOf = (res: request.Response) => res.body?.errors?.[0]?.code;

async function makeLead(extra: Record<string, unknown> = {}, organizationId = orgId) {
  return Lead.create({
    organizationId, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', phone: nextPhone(), email: `draft${++serial}@example.com`,
    source: 'Inbound SMS', channel: 'sms', status: 'New', comments: 'Is the Tacoma available?', ...extra,
  });
}

async function seedSmsThread(lead: any) {
  const conversation = await Conversation.create({ orgId: String(orgId), customerPhone: lead.phone, leadId: lead._id, aiPausedAt: pausedAt, aiPausedBy: { userId: String(ids.employee), name: 'Erin' } });
  await CommunicationMessage.create([
    { orgId: String(orgId), conversationId: conversation._id, leadId: lead._id, direction: 'inbound', body: 'Is the Tacoma still on the lot?', from: lead.phone, to: '+18015550999', status: 'received' },
    { orgId: String(orgId), conversationId: conversation._id, leadId: lead._id, direction: 'outbound', body: 'Hi Pat, let me check on that.', from: '+18015550999', to: lead.phone, status: 'delivered', sentBy: { userId: 'ai-agent', name: 'Anna' } },
  ] as any[]);
  return conversation;
}

async function snapshot() {
  return {
    sms: await CommunicationMessage.countDocuments({ orgId: String(orgId) }),
    chats: await WebChatMessage.countDocuments({ organizationId: String(orgId) }),
    logs: await AiAgentLog.countDocuments({}),
    conversations: await Conversation.countDocuments({ orgId: String(orgId) }),
    sessions: await WebChatSession.countDocuments({ organizationId: String(orgId) }),
  };
}

const usage = async () => ((await AiUsageCounter.findOne({ organizationId: String(orgId), kind: 'staff_draft' }).lean()) as any)?.count || 0;

describe('Real-DB: staff AI draft assistant (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    process.env.SKIP_RATE_LIMIT = 'true';
    await Promise.all([Lead.createIndexes(), AiUsageCounter.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Summit Motors', slug: `draft-${orgId}`, status: 'active', metadata: { aiAgentName: 'Anna', aiAgentEnabled: false } },
      { _id: unnamedOrgId, name: 'Unnamed Motors', slug: `draft-${unnamedOrgId}`, status: 'active', metadata: { aiAgentEnabled: true } },
      { _id: offOrgId, name: 'Off Motors', slug: `draft-${offOrgId}`, status: 'active', metadata: OFF_METADATA },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.employee, organizationId: orgId, fullName: 'Erin Employee', username: `draft-${ids.employee}`, email: `draft-emp-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.limited, organizationId: orgId, fullName: 'Lee Limited', username: `draft-${ids.limited}`, email: `draft-lim-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.unnamedEmployee, organizationId: unnamedOrgId, fullName: 'Una Other', username: `draft-${ids.unnamedEmployee}`, email: `draft-una-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.offEmployee, organizationId: offOrgId, fullName: 'Omar Employee', username: `draft-${ids.offEmployee}`, email: `draft-off-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    tokens.employee = generateCrmToken(String(ids.employee));
    tokens.limited = generateCrmToken(String(ids.limited));
    tokens.unnamed = generateCrmToken(String(ids.unnamedEmployee));
    tokens.off = generateCrmToken(String(ids.offEmployee));
  });

  beforeEach(() => {
    clearLeadIntakeModeCache();
    mockSendSms.mockReset();
    mockMessagesSend.mockReset();
    mockGenerateReply.mockReset();
    mockGenerateReply.mockResolvedValue({ text: 'Thanks Pat, I will confirm that with the team and text you back shortly.' });
    mockGenerateEmailReply.mockReset();
    mockGenerateEmailReply.mockResolvedValue({ text: 'Hi Pat, thanks for your email. I will confirm the details with the team and get back to you today.' });
    mockClassify.mockReset();
    mockClassify.mockResolvedValue('SAFE');
    mockClassifyEmail.mockReset();
    mockClassifyEmail.mockResolvedValue('SAFE');
  });

  afterAll(async () => {
    if (savedSkip === undefined) delete process.env.SKIP_RATE_LIMIT;
    else process.env.SKIP_RATE_LIMIT = savedSkip;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('returns an SMS draft without sending, logging, or changing takeover state', async () => {
    const lead = await makeLead();
    const conversation = await seedSmsThread(lead);
    const before = await snapshot();
    const leadBefore: any = await Lead.findById(lead._id).lean();
    const usageBefore = await usage();

    const res = await draft(lead._id, 'sms');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ draft: 'Thanks Pat, I will confirm that with the team and text you back shortly.', channel: 'sms', agentName: 'Anna', note: null, safetyWarning: null });
    const call = mockGenerateReply.mock.calls[0][0];
    expect(call).toMatchObject({ agentName: 'Anna', dealerName: 'Summit Motors', channel: 'sms', draftFor: { name: 'Erin Employee' } });
    expect(call.transcript).toEqual(expect.arrayContaining([
      { from: 'customer', body: 'Is the Tacoma still on the lot?' },
      { from: 'staff', staffName: 'Anna (AI assistant)', body: 'Hi Pat, let me check on that.' },
    ]));
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockMessagesSend).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
    const conversationAfter: any = await Conversation.findById(conversation._id).lean();
    expect(conversationAfter.aiPausedAt?.toISOString()).toBe(pausedAt.toISOString());
    expect(conversationAfter.aiPausedBy?.name).toBe('Erin');
    expect(conversationAfter.aiAutoPausedUntil ?? null).toBeNull();
    expect(conversationAfter.aiGeneratingAt ?? null).toBeNull();
    const leadAfter: any = await Lead.findById(lead._id).lean();
    expect(leadAfter.updatedAt.toISOString()).toBe(leadBefore.updatedAt.toISOString());
    expect(leadAfter.status).toBe('New');
    expect(await usage()).toBe(usageBefore + 1);
  });

  it('drafts an Email reply with the email generator', async () => {
    const lead = await makeLead({ channel: 'web', source: 'Website Inquiry' });
    const before = await snapshot();
    const res = await draft(lead._id, 'email');
    expect(res.status).toBe(200);
    expect(res.body.data.channel).toBe('email');
    expect(mockGenerateEmailReply).toHaveBeenCalledTimes(1);
    expect(mockGenerateReply).not.toHaveBeenCalled();
    expect(mockMessagesSend).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('drafts a Web Chat reply during an explicit takeover and leaves the session paused', async () => {
    const lead = await makeLead({ channel: 'webchat', source: 'Website Chat' });
    const session = await WebChatSession.create({ organizationId: String(orgId), leadId: lead._id, tokenHash: `hash-${serial}`, visitorName: 'Pat', aiPausedAt: pausedAt, aiPausedBy: { userId: String(ids.employee), name: 'Erin' } });
    await WebChatMessage.create({ organizationId: String(orgId), sessionId: session._id, leadId: lead._id, direction: 'inbound', body: 'Do you have it in blue?' });
    const before = await snapshot();
    const res = await draft(lead._id, 'webchat');
    expect(res.status).toBe(200);
    expect(mockGenerateReply.mock.calls[0][0]).toMatchObject({ channel: 'webchat' });
    expect(mockGenerateReply.mock.calls[0][0].transcript).toEqual(expect.arrayContaining([{ from: 'customer', body: 'Do you have it in blue?' }]));
    expect(await snapshot()).toEqual(before);
    const after: any = await WebChatSession.findById(session._id).lean();
    expect(after.aiPausedAt.toISOString()).toBe(pausedAt.toISOString());
    expect(after.aiAutoPausedUntil).toBeUndefined();
    expect(after.aiGeneratingAt).toBeUndefined();
  });

  it('lets an employee draft while automatic AI is Off, without turning anything on', async () => {
    const lead = await makeLead({}, offOrgId);
    const conversation = await Conversation.create({ orgId: String(offOrgId), customerPhone: lead.phone, leadId: lead._id });
    await CommunicationMessage.create({ orgId: String(offOrgId), conversationId: conversation._id, leadId: lead._id, direction: 'inbound', body: 'Is it still available?', from: lead.phone, to: '+18015550999', status: 'received' } as any);
    const messagesBefore = await CommunicationMessage.countDocuments({ orgId: String(offOrgId) });
    const logsBefore = await AiAgentLog.countDocuments({});

    const res = await draft(lead._id, 'sms', 'off');

    expect(res.status).toBe(200);
    expect(res.body.data.agentName).toBe('Riley');
    expect(mockGenerateReply).toHaveBeenCalledTimes(1);
    const org: any = await Organization.findById(offOrgId).lean();
    expect(org.metadata).toEqual(OFF_METADATA);
    expect(await CommunicationMessage.countDocuments({ orgId: String(offOrgId) })).toBe(messagesBefore);
    expect(await AiAgentLog.countDocuments({})).toBe(logsBefore);
    const convo: any = await Conversation.findById(conversation._id).lean();
    expect(convo.aiPausedAt ?? null).toBeNull();
    expect(convo.aiAutoPausedUntil ?? null).toBeNull();
    expect(convo.aiGeneratingAt ?? null).toBeNull();
    expect(mockSendSms).not.toHaveBeenCalled();
  });

  it('blocks drafting when the organization has no AI Agent name', async () => {
    const lead = await makeLead({}, unnamedOrgId);
    const res = await draft(lead._id, 'sms', 'unnamed');
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe('AI_AGENT_NAME_REQUIRED');
    expect(res.body.message).toBe('Set an AI Agent name in CRM Settings to enable AI features.');
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('never returns another organization\'s lead', async () => {
    const lead = await makeLead({}, unnamedOrgId);
    const res = await draft(lead._id, 'sms');
    expect(res.status).toBe(404);
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('refuses a channel that does not belong to the lead', async () => {
    const chatLead = await makeLead({ channel: 'webchat', source: 'Website Chat' });
    const smsLead = await makeLead();
    expect(codeOf(await draft(chatLead._id, 'sms'))).toBe('AI_DRAFT_WRONG_CHANNEL');
    expect(codeOf(await draft(smsLead._id, 'webchat'))).toBe('AI_DRAFT_WRONG_CHANNEL');
    expect(codeOf(await draft(smsLead._id, 'fax'))).toBe('AI_DRAFT_WRONG_CHANNEL');
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('does not draft for a Do Not Contact customer', async () => {
    const lead = await makeLead({ status: 'Do Not Contact' });
    const res = await draft(lead._id, 'sms');
    expect(res.status).toBe(403);
    expect(codeOf(res)).toBe('CONTACT_RESTRICTED');
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('does not draft for a closed lead while lifecycle intake is active', async () => {
    const lead = await makeLead({ status: 'Sold' });
    await setLeadIntakeMode({ organizationId: String(orgId), mode: 'active', reason: 'draft test', actor: { userId: String(ids.employee), name: 'Erin' } });
    clearLeadIntakeModeCache();
    try {
      const res = await draft(lead._id, 'sms');
      expect(res.status).toBe(409);
      expect(codeOf(res)).toBe('lead_closed');
    } finally {
      await setLeadIntakeMode({ organizationId: String(orgId), mode: 'off', reason: 'draft test done', actor: { userId: String(ids.employee), name: 'Erin' } });
      clearLeadIntakeModeCache();
    }
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('returns the friendly message instead of a provider error, and records no usage', async () => {
    const lead = await makeLead();
    const usageBefore = await usage();
    mockGenerateReply.mockResolvedValue({ text: null, error: 'AxiosError: Request failed with status code 503' });
    const res = await draft(lead._id, 'sms');
    expect(res.status).toBe(502);
    expect(res.body.message).toBe("Couldn't generate a reply right now. Please try again.");
    expect(JSON.stringify(res.body)).not.toMatch(/Axios|status code/);
    expect(await usage()).toBe(usageBefore);
  });

  it('shows a flagged suggestion with a warning instead of hiding it', async () => {
    const lead = await makeLead();
    mockGenerateReply.mockResolvedValue({ text: 'Good news, it is $2,000 off this week!' });
    const res = await draft(lead._id, 'sms');
    expect(res.status).toBe(200);
    expect(res.body.data.draft).toBe('Good news, it is $2,000 off this week!');
    expect(res.body.data.safetyWarning).toContain('Check this before sending');
  });

  it('rejects an overlapping request for the same lead and channel', async () => {
    const lead = await makeLead();
    let release: (value: unknown) => void = () => undefined;
    let started: () => void = () => undefined;
    const generationStarted = new Promise<void>((resolve) => { started = resolve; });
    mockGenerateReply.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => { release = resolve; });
    });
    const first = draft(lead._id, 'sms').then((res) => res);
    await generationStarted;
    const second = await draft(lead._id, 'sms');
    expect(second.status).toBe(409);
    expect(codeOf(second)).toBe('AI_DRAFT_IN_PROGRESS');
    release({ text: 'Thanks Pat, I will confirm that with the team.' });
    expect((await first).status).toBe(200);
    expect(mockGenerateReply).toHaveBeenCalledTimes(1);
  });

  it('rate limits repeated draft requests from one staff member', async () => {
    const lead = await makeLead();
    process.env.SKIP_RATE_LIMIT = 'false';
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 13; attempt++) statuses.push((await draft(lead._id, 'sms', 'limited')).status);
      expect(statuses.slice(0, 12).every((status) => status === 200)).toBe(true);
      expect(statuses[12]).toBe(429);
    } finally {
      process.env.SKIP_RATE_LIMIT = 'true';
    }
  });
});
