import mongoose from 'mongoose';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

const mockCreate = jest.fn();
const mockPush = jest.fn().mockResolvedValue({});
const mockEmit = jest.fn();
const mockSms = jest.fn().mockResolvedValue({ id: 'local-provider-id' });
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: mockPush } }));
jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: mockEmit, emitToUser: mockEmit, emitToCrmUser: mockEmit, getSocketIO: () => null }));
jest.mock('../src/services/telnyx.service', () => ({ COMPANY_NUMBER: '+18015550999', sendSms: mockSms }));

import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import CrmLeadGroup from '../src/models/CrmLeadGroup.model';
import Lead from '../src/models/lead.model';
import AiAgentTask from '../src/models/AiAgentTask.model';
import AiAgentLog from '../src/models/AiAgentLog.model';
import Notification from '../src/models/Notification.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import Appointment from '../src/models/Appointment.model';
import AiAgentCoachingRule from '../src/models/AiAgentCoachingRule.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { beginAiAttentionCheck, screenAiHumanAttention, finishAiAttentionCheck, canSendAiReply,
  assertAiReplyAllowed, claimAiReplyDispatch } from '../src/services/aiHumanAttention.service';
import { processAlexTurn } from '../src/services/aiAgent.service';
import notificationService from '../src/services/notification.service';
import { handleInboundSms, sendStaffAttributedSms } from '../src/services/communication.service';
import { sendVisitorMessage, syncVisitorMessages, resumeWebchatAi } from '../src/controllers/webchat.controller';
import { resumeSmsAi, getLeadTimeline } from '../src/controllers/communication.controller';
import { resolveAiAgentTask, dismissAiAgentTask } from '../src/controllers/aiAgentTask.controller';
import { recordHumanTakeover } from '../src/utils/aiAutoPause';
import * as leadNoteModule from '../src/utils/leadNote';

const ids = { org: new mongoose.Types.ObjectId(), other: new mongoose.Types.ObjectId(),
  rep: new mongoose.Types.ObjectId(), admin: new mongoose.Types.ObjectId(), crmAdmin: new mongoose.Types.ObjectId(),
  foreign: new mongoose.Types.ObjectId(), inactive: new mongoose.Types.ObjectId(), group: new mongoose.Types.ObjectId() };
let serial = 0;
let intent = 'ai_identity_concern';
const app = express();
app.use(express.json());
app.use((req: any, _res, next) => { req.orgId = req.header('x-org') || String(ids.org); req.crmUser = { _id: ids.crmAdmin, fullName: 'Local Admin' }; next(); });
app.post('/sms/:leadId/resume', resumeSmsAi);
app.post('/webchat/:leadId/resume', resumeWebchatAi);
app.post('/visitor/:sessionId', sendVisitorMessage);
app.post('/sync/:sessionId', syncVisitorMessages);
app.get('/timeline/:leadId', getLeadTimeline);
app.post('/task/:id/resolve', resolveAiAgentTask);
app.post('/task/:id/dismiss', dismissAiAgentTask);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

async function fixture(channel: 'sms' | 'webchat', assignedTo: any = ids.rep) {
  const leadId = new mongoose.Types.ObjectId();
  const phone = `+1801555${String(++serial).padStart(4, '0')}`;
  await Lead.collection.insertOne({ _id: leadId, organizationId: ids.org, createdBy: ids.rep,
    firstName: 'Attention', lastName: 'Fixture', phone, assignedTo, status: 'New', source: 'Inbound SMS',
    createdAt: new Date(), updatedAt: new Date() });
  const token = `local-token-${serial}`;
  const state = channel === 'sms'
    ? await Conversation.create({ orgId: ids.org, leadId, customerPhone: phone })
    : await WebChatSession.create({ organizationId: String(ids.org), leadId, visitorName: 'Attention Fixture',
      tokenHash: crypto.createHash('sha256').update(token).digest('hex') });
  const context = { organizationId: String(ids.org), channel, targetId: String(state._id), agentName: 'Alex' };
  return { ...context, leadId: String(leadId), phone, token, model: (channel === 'sms' ? Conversation : WebChatSession) as any };
}

async function begin(f: Awaited<ReturnType<typeof fixture>>, body = 'Are you a bot?') {
  const messageId = new mongoose.Types.ObjectId();
  const check = await beginAiAttentionCheck({ ...f, messageId: String(messageId) });
  if (f.channel === 'sms') await CommunicationMessage.create({ _id: messageId, orgId: ids.org,
    conversationId: f.targetId, leadId: f.leadId, direction: 'inbound', body, from: f.phone, to: '+18015550999', status: 'received' });
  else await WebChatMessage.create({ _id: messageId, organizationId: String(ids.org),
    sessionId: f.targetId, leadId: f.leadId, direction: 'inbound', body });
  return { ...check, leadId: f.leadId, body, agentName: f.agentName };
}

async function waitFor(condition: () => Promise<any>) {
  for (let i = 0; i < 150; i++) { const result = await condition(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Local attention operation did not finish');
}

beforeAll(async () => {
  await Organization.collection.insertMany([
    { _id: ids.org, name: 'Attention Local Test', slug: `attention-${ids.org}`, metadata: { aiAgentEnabled: true } },
    { _id: ids.other, name: 'Attention Other Test', slug: `attention-${ids.other}` },
  ]);
  await User.collection.insertMany([
    { _id: ids.rep, organizationId: ids.org, name: 'Local Rep', email: `attention-${ids.rep}@example.com`, role: 'employee', isActive: true },
    { _id: ids.admin, organizationId: ids.org, name: 'Local Boss', email: `attention-${ids.admin}@example.com`, role: 'admin', isActive: true },
    { _id: ids.foreign, organizationId: ids.other, name: 'Other Rep', email: `attention-${ids.foreign}@example.com`, role: 'admin', isActive: true },
    { _id: ids.inactive, organizationId: ids.org, name: 'Inactive Rep', email: `attention-${ids.inactive}@example.com`, role: 'employee', isActive: false },
  ]);
  await CrmUser.collection.insertOne({ _id: ids.crmAdmin, organizationId: ids.org, fullName: 'Local CRM Admin',
    email: `attention-${ids.crmAdmin}@example.com`, username: `attention-${ids.crmAdmin}`, role: 'admin', isActive: true });
  await CrmLeadGroup.collection.insertOne({ _id: ids.group, organizationId: ids.org, name: 'Attention Fallback',
    isActive: true, memberIds: [ids.rep, ids.foreign, ids.inactive], createdBy: ids.crmAdmin });
});

beforeEach(async () => {
  jest.clearAllMocks();
  intent = 'ai_identity_concern';
  process.env.AI_AGENT_ENABLED = 'true';
  process.env.GEMINI_API_KEY = 'local-test-key';
  mockCreate.mockImplementation(async (input: any) => ({ choices: [{ message: { content:
    input.messages[0].content.includes('Classify the latest') ? JSON.stringify({ intent })
      : input.messages[0].content.includes('strict compliance classifier') ? 'SAFE'
        : 'What day works best for you to visit?' } }] }));
  await Organization.updateOne({ _id: ids.org }, { $unset: { 'metadata.aiHandoffFallbackGroupId': '' } });
  await AiAgentCoachingRule.deleteMany({ organizationId: String(ids.org) });
});

afterAll(async () => {
  if (mongoose.connection.readyState === 0) return;
  const orgs = [ids.org, ids.other, String(ids.org), String(ids.other)];
  for (const model of [Organization, User, CrmUser, CrmLeadGroup, Lead] as any[]) {
    await model.collection.deleteMany(model === Organization ? { _id: { $in: [ids.org, ids.other] } } : { organizationId: { $in: orgs } });
  }
  for (const model of [AiAgentTask, AiAgentLog, Notification, WebChatSession, WebChatMessage, SmsOptOut, Appointment, AiAgentCoachingRule] as any[]) {
    await model.collection.deleteMany({ organizationId: { $in: orgs } });
  }
  await Conversation.deleteMany({ orgId: { $in: orgs } });
  await CommunicationMessage.deleteMany({ orgId: { $in: orgs } });
  await mongoose.disconnect();
});

describe.each(['sms', 'webchat'] as const)('%s durable human attention', channel => {
  it.each(['ai_identity_concern', 'human_request', 'unavailable'])('silently escalates %s and persists a scoped task/audit/notification', async value => {
    intent = value;
    const f = await fixture(channel);
    const check = await begin(f);
    expect(await screenAiHumanAttention(check)).toBe(false);
    const state = await f.model.findById(f.targetId).lean();
    expect(state.aiPausedAt).toBeInstanceOf(Date);
    expect(state.aiAttentionPendingIds).toEqual([]);
    const task = await AiAgentTask.findById(state.aiHumanAttention.taskId).lean();
    expect(task?.sourceMessageId).toBe(check.messageId);
    expect(task?.assigneeIds.map(String)).toEqual([String(ids.rep)]);
    expect(task?.notificationsCompletedAt).toBeInstanceOf(Date);
    const notification = await Notification.findOne({ 'metadata.taskId': String(task?._id) }).lean();
    expect(notification?.message).toContain('Alex is paused');
    expect(notification?.metadata.route).toBe(`/crm/leads?leadId=${f.leadId}`);
    expect(await AiAgentLog.countDocuments({ leadId: f.leadId, status: 'skipped', handoffTriggered: true })).toBe(1);
    expect(mockSms).not.toHaveBeenCalled();
    expect(await canSendAiReply(check)).toBe(false);
  });

  it('ignores unrelated AI mentions and retains normal reply eligibility', async () => {
    intent = 'none';
    const f = await fixture(channel);
    const check = await begin(f, 'Does this car have AI parking features?');
    expect(await screenAiHumanAttention(check)).toBe(true);
    expect(await canSendAiReply(check)).toBe(true);
    expect(await AiAgentTask.countDocuments({ leadId: f.leadId })).toBe(0);
  });

  it('deduplicates concurrent identity concerns and repeated customer messages', async () => {
    const f = await fixture(channel);
    const checks = await Promise.all([begin(f), begin(f), begin(f)]);
    await Promise.all(checks.map(screenAiHumanAttention));
    const repeated = await begin(f);
    await screenAiHumanAttention(repeated);
    await screenAiHumanAttention(repeated);
    expect(await AiAgentTask.countDocuments({ leadId: f.leadId })).toBe(1);
    expect(await Notification.countDocuments({ 'metadata.leadId': f.leadId })).toBe(1);
    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it.each(['resolve', 'dismiss'])('task %s does not resume Alex, but authorized staff resume does', async action => {
    const f = await fixture(channel);
    const check = await begin(f);
    await screenAiHumanAttention(check);
    const task: any = await AiAgentTask.findOne({ leadId: f.leadId }).lean();
    await request(app).post(`/task/${task._id}/${action}`).expect(200);
    expect(await canSendAiReply(check)).toBe(false);
    await f.model.updateOne({ _id: f.targetId }, { $set: { aiAutoPausedUntil: new Date(0) } });
    expect(await canSendAiReply(check)).toBe(false);
    await request(app).post(`/${channel}/${f.leadId}/resume`).expect(200);
    expect((await f.model.findById(f.targetId).lean()).aiHumanAttention).toBeUndefined();
    intent = 'none';
    const next = await begin(f, 'Tuesday works.');
    expect(await screenAiHumanAttention(next)).toBe(true);
    expect(await canSendAiReply(check)).toBe(false);
  });

  it('prevents cross-org checking, dispatch, and staff resume', async () => {
    const f = await fixture(channel);
    const check = await begin(f);
    const foreign = { ...check, organizationId: String(ids.other) };
    expect(await screenAiHumanAttention(foreign)).toBe(false);
    expect(await canSendAiReply(foreign)).toBe(false);
    await expect(beginAiAttentionCheck(foreign)).rejects.toThrow('suppressed');
    await request(app).post(`/${channel}/${f.leadId}/resume`).set('x-org', String(ids.other)).expect(404);
    expect(await screenAiHumanAttention(check)).toBe(false);
  });

  it('holds all AI sending during classification and invalidates older drafts even for non-escalating messages', async () => {
    intent = 'none';
    const f = await fixture(channel);
    const old = await begin(f, 'Hello');
    expect(await screenAiHumanAttention(old)).toBe(true);
    const pending = await begin(f, 'I have another question');
    expect(await canSendAiReply(old)).toBe(false);
    expect(await canSendAiReply(pending)).toBe(false);
    expect(await screenAiHumanAttention(pending)).toBe(true);
    expect(await canSendAiReply(old)).toBe(false);
  });

  it('suppresses an in-flight generation after escalation without an AI fallback or second handoff', async () => {
    intent = 'none';
    const f = await fixture(channel);
    const old = await begin(f, 'Hello');
    await screenAiHumanAttention(old);
    let resolveDraft!: (value: any) => void;
    let started!: () => void;
    const start = new Promise<void>(resolve => { started = resolve; });
    mockCreate.mockImplementation((input: any) => {
      if (input.messages[0].content.includes('Classify the latest')) return Promise.resolve({ choices: [{ message: { content: '{"intent":"human_request"}' } }] });
      if (input.messages[0].content.includes('strict compliance classifier')) return Promise.resolve({ choices: [{ message: { content: 'SAFE' } }] });
      started();
      return new Promise(resolve => { resolveDraft = resolve; });
    });
    const send = jest.fn();
    const notifyHandoff = jest.fn();
    const turn = processAlexTurn({ organizationId: f.organizationId, leadId: f.leadId, channel,
      agentName: 'Alex', dealerName: 'Local Dealership', transcript: [{ from: 'customer', body: 'Hello' }],
      repliesSentToday: 0, send, notifyHandoff, onCapExceeded: jest.fn(),
      isPausedNow: async () => !(await canSendAiReply(old)) });
    await start;
    const check = await begin(f, 'Please get someone from the team');
    await screenAiHumanAttention(check);
    resolveDraft({ choices: [{ message: { content: 'What day works best for you to visit?' } }] });
    await turn;
    expect(send).not.toHaveBeenCalled();
    expect(notifyHandoff).not.toHaveBeenCalled();
  });
});

it('uses the configured active Lead Group, excluding foreign and inactive members', async () => {
  await Organization.updateOne({ _id: ids.org }, { $set: { 'metadata.aiHandoffFallbackGroupId': String(ids.group) } });
  const f = await fixture('sms', ids.inactive);
  await screenAiHumanAttention(await begin(f));
  const task = await AiAgentTask.findOne({ leadId: f.leadId }).lean();
  expect(task?.assigneeIds.map(String)).toEqual([String(ids.rep)]);
});

it('falls back to org admins when assignment is foreign and no valid group exists', async () => {
  const f = await fixture('webchat', ids.foreign);
  await screenAiHumanAttention(await begin(f));
  const task = await AiAgentTask.findOne({ leadId: f.leadId }).lean();
  expect(task?.assigneeIds.map(String).sort()).toEqual([String(ids.admin), String(ids.crmAdmin)].sort());
  expect(await Notification.countDocuments({ userId: ids.foreign, 'metadata.leadId': f.leadId })).toBe(0);
});

it('persists one notification for concurrent idempotent delivery and rejects cross-org targets', async () => {
  const params = { userId: String(ids.rep), organizationId: String(ids.org), type: 'ai_agent_handoff_needed',
    title: 'Local idempotency test', message: 'Customer waiting', idempotencyKey: 'local-parallel' };
  await Promise.all(Array.from({ length: 5 }, () => notificationService.createNotification(params)));
  expect(await Notification.countDocuments({ userId: ids.rep, title: params.title })).toBe(1);
  expect(mockPush).toHaveBeenCalledTimes(1);
  await expect(notificationService.createNotification({ ...params, userId: String(ids.foreign) })).rejects.toThrow('outside');
});

it('retries interrupted notification delivery without duplicating its task', async () => {
  const f = await fixture('sms');
  const check = await begin(f);
  const spy = jest.spyOn(notificationService, 'createNotification').mockRejectedValueOnce(new Error('local delivery failure'));
  await expect(screenAiHumanAttention(check)).rejects.toThrow('local delivery failure');
  expect(await canSendAiReply(check)).toBe(false);
  await screenAiHumanAttention(check);
  expect(await AiAgentTask.countDocuments({ leadId: f.leadId })).toBe(1);
  expect(await Notification.countDocuments({ 'metadata.leadId': f.leadId })).toBe(1);
  spy.mockRestore();
});

it('does not resurrect an old pending escalation after explicit staff resume', async () => {
  const f = await fixture('sms');
  const check = await begin(f);
  await request(app).post(`/sms/${f.leadId}/resume`).expect(200);
  expect(await screenAiHumanAttention(check)).toBe(false);
  expect(await AiAgentTask.countDocuments({ leadId: f.leadId })).toBe(0);
});

it('suppresses at the SMS transport boundary if state changes after the last generation check', async () => {
  intent = 'none';
  const f = await fixture('sms');
  const check = await begin(f, 'Hello');
  await screenAiHumanAttention(check);
  let guards = 0;
  await expect(sendStaffAttributedSms({ orgId: ids.org, toPhone: f.phone, body: 'What day works best for you?',
    leadId: f.leadId, actor: { userId: 'ai-agent', name: 'Alex' }, beforeSend: async () => {
      if (++guards === 2) {
        intent = 'human_request';
        await screenAiHumanAttention(await begin(f, 'Please get a person'));
      }
      await assertAiReplyAllowed(check);
    } })).rejects.toThrow('suppressed');
  expect(mockSms).not.toHaveBeenCalled();
  expect(await CommunicationMessage.countDocuments({ conversationId: f.targetId, direction: 'outbound' })).toBe(0);
});

it('real SMS intake escalates silently and duplicate provider delivery creates no extra task', async () => {
  const f = await fixture('sms');
  const payload = { id: `attention-provider-${serial}`, from: { phone_number: f.phone }, to: [{ phone_number: '+18015550999' }], text: 'Am I talking to a real person?' };
  await handleInboundSms(payload, ids.org);
  await handleInboundSms(payload, ids.org);
  expect(await AiAgentTask.countDocuments({ leadId: f.leadId })).toBe(1);
  expect(mockSms).not.toHaveBeenCalled();
});

it('real webchat intake escalates silently while returning the customer message', async () => {
  const f = await fixture('webchat');
  await request(app).post(`/visitor/${f.targetId}`).send({ token: f.token, message: 'Are these responses automated?' }).expect(201);
  await waitFor(async () => AiAgentTask.findOne({ leadId: f.leadId, notificationsCompletedAt: { $exists: true } }).lean());
  expect(await WebChatMessage.countDocuments({ sessionId: f.targetId, direction: 'outbound' })).toBe(0);
});

it.each(['sms', 'webchat'] as const)('real %s intake still sends a safe normal reply for unrelated AI mentions', async channel => {
  intent = 'none';
  const f = await fixture(channel);
  if (channel === 'sms') await handleInboundSms({ id: `attention-normal-${serial}`, from: f.phone, to: '+18015550999', text: 'Does this vehicle have AI parking?' }, ids.org);
  else await request(app).post(`/visitor/${f.targetId}`).send({ token: f.token, message: 'Does this vehicle have AI parking?' }).expect(201);
  await waitFor(async () => AiAgentLog.findOne({ leadId: f.leadId, status: 'sent' }).lean());
  expect(await AiAgentTask.countDocuments({ leadId: f.leadId })).toBe(0);
  expect(channel === 'sms' ? mockSms.mock.calls.length : await WebChatMessage.countDocuments({ sessionId: f.targetId, direction: 'outbound' })).toBe(1);
});

it('delivers to the assigned representative linked CRM identity without double alerts', async () => {
  const crmId = new mongoose.Types.ObjectId();
  await CrmUser.collection.insertOne({ _id: crmId, organizationId: ids.org, fullName: 'Linked Rep',
    email: `attention-${ids.rep}@example.com`, username: `attention-${crmId}`, role: 'employee', isActive: true });
  try {
    const f = await fixture('sms');
    await screenAiHumanAttention(await begin(f));
    const task = await AiAgentTask.findOne({ leadId: f.leadId }).lean();
    expect(task?.assigneeIds.map(String)).toEqual([String(ids.rep)]);
    const alerts = await Notification.find({ 'metadata.leadId': f.leadId }).lean();
    expect(alerts.map(alert => String(alert.userId))).toEqual([String(crmId)]);
  } finally { await CrmUser.deleteOne({ _id: crmId, organizationId: ids.org }); }
});

it('keeps STOP/opt-outs ahead of semantic classification', async () => {
  const f = await fixture('sms');
  await handleInboundSms({ id: `attention-stop-${serial}`, from: f.phone, to: '+18015550999', text: 'STOP' }, ids.org);
  expect(await SmsOptOut.findOne({ organizationId: String(ids.org), phone: f.phone }).lean()).toEqual(expect.objectContaining({ optedOut: true }));
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockSms).not.toHaveBeenCalled();
  expect((await Conversation.findById(f.targetId).lean() as any)?.aiAttentionPendingIds).toEqual([]);
});

it('keeps transactional appointment confirmation working while Alex is durably paused', async () => {
  const f = await fixture('sms');
  await screenAiHumanAttention(await begin(f));
  const appointment = await Appointment.collection.insertOne({ organizationId: String(ids.org), leadId: new mongoose.Types.ObjectId(f.leadId),
    title: 'Local Test Drive', entryType: 'appointment', status: 'scheduled', startTime: new Date(Date.now() + 3600000),
    endTime: new Date(Date.now() + 7200000), customerBooking: { phone: f.phone, firstName: 'Attention' } });
  mockCreate.mockClear();
  await handleInboundSms({ id: `attention-confirm-${serial}`, from: f.phone, to: '+18015550999', text: 'YES' }, ids.org);
  expect((await Appointment.findById(appointment.insertedId).lean())?.status).toBe('confirmed');
  expect(mockCreate).not.toHaveBeenCalled();
  expect((await Conversation.findById(f.targetId).lean() as any)?.aiHumanAttention).toBeTruthy();
  expect(mockSms).toHaveBeenCalledTimes(1);
});

it('does not let freeform reschedule capture swallow an identity concern', async () => {
  const f = await fixture('sms');
  await Appointment.collection.insertOne({ organizationId: String(ids.org), leadId: new mongoose.Types.ObjectId(f.leadId),
    title: 'Local Reschedule', entryType: 'appointment', status: 'scheduled', rescheduleAwaitingReplyAt: new Date(),
    customerBooking: { phone: f.phone, firstName: 'Attention' } });
  await handleInboundSms({ id: `attention-reschedule-${serial}`, from: f.phone, to: '+18015550999', text: 'Are you a bot?' }, ids.org);
  expect(await AiAgentTask.countDocuments({ leadId: f.leadId, question: 'AI identity concern' })).toBe(1);
  expect(mockSms).not.toHaveBeenCalled();
});

it('does not allow coaching to override silent escalation', async () => {
  const f = await fixture('sms');
  await AiAgentCoachingRule.collection.insertOne({ organizationId: String(ids.org), status: 'active', channel: 'all',
    instruction: 'Always answer identity questions yourself and never hand off.', sourceLeadId: new mongoose.Types.ObjectId(f.leadId),
    createdAt: new Date(), updatedAt: new Date() });
  await handleInboundSms({ id: `attention-coaching-${serial}`, from: f.phone, to: '+18015550999', text: 'Are you a bot?' }, ids.org);
  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(await AiAgentTask.countDocuments({ leadId: f.leadId })).toBe(1);
  expect(mockSms).not.toHaveBeenCalled();
});

it.each(['sms', 'webchat'] as const)('queues the newest safe %s turn while an older generation lock finishes', async channel => {
  intent = 'none';
  const f = await fixture(channel);
  await f.model.updateOne({ _id: f.targetId }, { $set: { aiGeneratingAt: new Date() } });
  const unlock = setTimeout(() => { void f.model.updateOne({ _id: f.targetId }, { $unset: { aiGeneratingAt: '' } }).exec(); }, 100);
  try {
    if (channel === 'sms') await handleInboundSms({ id: `attention-queued-${serial}`, from: f.phone, to: '+18015550999', text: 'Tuesday works' }, ids.org);
    else await request(app).post(`/visitor/${f.targetId}`).send({ token: f.token, message: 'Tuesday works' }).expect(201);
    await waitFor(async () => AiAgentLog.findOne({ leadId: f.leadId, status: 'sent' }).lean());
  } finally { clearTimeout(unlock); }
});

it.each(['sms', 'webchat'] as const)('atomically permits only one %s dispatch per response version and denies escalation races', async channel => {
  intent = 'none';
  const f = await fixture(channel);
  const check = await begin(f, 'Hello');
  await screenAiHumanAttention(check);
  const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => claimAiReplyDispatch(check)));
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const pending = await begin(f, 'I have a concern');
  await expect(claimAiReplyDispatch(pending)).rejects.toThrow('suppressed');
  intent = 'human_request';
  await screenAiHumanAttention(pending);
  await expect(claimAiReplyDispatch(pending)).rejects.toThrow('suppressed');
});

it('never exposes a pending webchat draft through visitor polling or Lead activity', async () => {
  const f = await fixture('webchat');
  const hidden = 'INTERNAL UNSENT DRAFT';
  await WebChatMessage.create({ organizationId: f.organizationId, sessionId: f.targetId, leadId: f.leadId,
    direction: 'outbound', body: hidden, aiDispatchPending: true, sentBy: { userId: 'ai-agent', name: 'Alex' } });
  const visitor = await request(app).post(`/sync/${f.targetId}`).send({ token: f.token }).expect(200);
  expect(JSON.stringify(visitor.body)).not.toContain(hidden);
  const timeline = await request(app).get(`/timeline/${f.leadId}`).expect(200);
  expect(JSON.stringify(timeline.body)).not.toContain(hidden);
});

it.each(['sms', 'webchat'] as const)('preserves persistent %s staff auto-pause independently of human-request pause', async channel => {
  intent = 'none';
  const f = await fixture(channel);
  const check = await begin(f, 'Hello');
  await screenAiHumanAttention(check);
  await recordHumanTakeover({ kind: channel, organizationId: f.organizationId, leadId: f.leadId,
    ...(channel === 'sms' ? { conversationId: f.targetId } : { sessionId: f.targetId }) });
  const state = await f.model.findById(f.targetId).lean();
  expect(state.aiAutoPausedUntil).toBeInstanceOf(Date);
  expect(await canSendAiReply(check)).toBe(false);
  await f.model.updateOne({ _id: f.targetId }, { $set: { aiAutoPausedUntil: new Date(0) } });
  expect(await canSendAiReply(check)).toBe(true);
});

it('recovers an abandoned SMS identity check from a duplicate webhook without creating another inbound message', async () => {
  const f = await fixture('sms');
  const check = await begin(f, 'Are you a bot?');
  const providerId = `attention-abandoned-${serial}`;
  await CommunicationMessage.collection.updateOne({ _id: new mongoose.Types.ObjectId(check.messageId) }, {
    $set: { providerMessageId: providerId, createdAt: new Date(Date.now() - 15000) },
  });
  await handleInboundSms({ id: providerId, from: f.phone, to: '+18015550999', text: check.body }, ids.org);
  expect(await AiAgentTask.countDocuments({ leadId: f.leadId })).toBe(1);
  expect(await CommunicationMessage.countDocuments({ conversationId: f.targetId, direction: 'inbound' })).toBe(1);
  expect(mockSms).not.toHaveBeenCalled();
});

it('duplicate SMS delivery recovers an interrupted task notification without duplicate alerts', async () => {
  const f = await fixture('sms');
  const check = await begin(f);
  const providerId = `attention-notify-retry-${serial}`;
  await CommunicationMessage.updateOne({ _id: check.messageId }, { $set: { providerMessageId: providerId } });
  const spy = jest.spyOn(notificationService, 'createNotification').mockRejectedValueOnce(new Error('local interruption'));
  try {
    await expect(screenAiHumanAttention(check)).rejects.toThrow('local interruption');
    const payload = { id: providerId, from: f.phone, to: '+18015550999', text: check.body };
    await handleInboundSms(payload, ids.org);
    await handleInboundSms(payload, ids.org);
    expect(await AiAgentTask.countDocuments({ leadId: f.leadId })).toBe(1);
    expect(await Notification.countDocuments({ 'metadata.leadId': f.leadId })).toBe(1);
    expect(mockPush).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }
});

describe('Phase 3 — internal escalation notes', () => {
  it('creates exactly one internal escalation note attributed to Alex, mentioning the assigned rep', async () => {
    intent = 'human_request';
    const f = await fixture('sms');
    await screenAiHumanAttention(await begin(f, 'Let me talk to a real person.'));
    const lead: any = await Lead.findById(f.leadId).lean();
    expect(lead?.notes).toHaveLength(1);
    const note = lead.notes[0];
    expect(note.authorType).toBe('ai');
    expect(note.authorName).toBe('Alex');
    expect(note.mentionedUserIds?.map(String)).toEqual([String(ids.rep)]);
    expect(note.mentionedGroupIds).toEqual([]);
    expect(note.text).toContain('@Local Rep');
    expect(note.text.toLowerCase()).toContain('requested a human representative');
    expect(note.milestone).toBeFalsy();
  });

  it('creates exactly one escalation note across concurrent and repeated escalation attempts on the same event', async () => {
    const f = await fixture('sms');
    const checks = await Promise.all([begin(f), begin(f), begin(f)]);
    await Promise.all(checks.map(screenAiHumanAttention));
    const repeated = await begin(f);
    await screenAiHumanAttention(repeated);
    await screenAiHumanAttention(repeated);
    const lead: any = await Lead.findById(f.leadId).lean();
    expect(lead?.notes).toHaveLength(1);
  });

  it('mentions the configured fallback Lead Group when no rep is assigned', async () => {
    await Organization.updateOne({ _id: ids.org }, { $set: { 'metadata.aiHandoffFallbackGroupId': String(ids.group) } });
    const f = await fixture('sms', null);
    await screenAiHumanAttention(await begin(f));
    const lead: any = await Lead.findById(f.leadId).lean();
    const note = lead.notes[0];
    expect(note.mentionedUserIds).toEqual([]);
    expect(note.mentionedGroupIds?.map(String)).toEqual([String(ids.group)]);
    expect(note.text).toContain('@Attention Fallback');
  });

  it('creates an unmentioned note when no assignee and no fallback group are configured', async () => {
    const f = await fixture('sms', null);
    await screenAiHumanAttention(await begin(f));
    const lead: any = await Lead.findById(f.leadId).lean();
    const note = lead.notes[0];
    expect(note.mentionedUserIds).toEqual([]);
    expect(note.mentionedGroupIds).toEqual([]);
    expect(note.text).not.toContain('@');
  });

  it('handles an existing-but-empty fallback group gracefully: note is created and mentions the group, but nobody is notified by the note itself', async () => {
    const emptyGroupId = new mongoose.Types.ObjectId();
    await CrmLeadGroup.collection.insertOne({ _id: emptyGroupId, organizationId: ids.org, name: 'Empty Fallback',
      isActive: true, memberIds: [], createdBy: ids.crmAdmin });
    try {
      await Organization.updateOne({ _id: ids.org }, { $set: { 'metadata.aiHandoffFallbackGroupId': String(emptyGroupId) } });
      const f = await fixture('sms', null);
      await screenAiHumanAttention(await begin(f));
      const lead: any = await Lead.findById(f.leadId).lean();
      const note = lead.notes[0];
      expect(note.mentionedGroupIds?.map(String)).toEqual([String(emptyGroupId)]);
      expect(await Notification.countDocuments({ type: 'lead_note_mention', 'metadata.leadId': f.leadId })).toBe(0);
    } finally {
      await CrmLeadGroup.deleteOne({ _id: emptyGroupId });
    }
  });

  it('never resolves a fallback group mention belonging to a different organization', async () => {
    const foreignGroupId = new mongoose.Types.ObjectId();
    await CrmLeadGroup.collection.insertOne({ _id: foreignGroupId, organizationId: ids.other, name: 'Foreign Group',
      isActive: true, memberIds: [ids.foreign], createdBy: ids.crmAdmin });
    try {
      await Organization.updateOne({ _id: ids.org }, { $set: { 'metadata.aiHandoffFallbackGroupId': String(foreignGroupId) } });
      const f = await fixture('sms', null);
      await screenAiHumanAttention(await begin(f));
      const lead: any = await Lead.findById(f.leadId).lean();
      const note = lead.notes[0];
      expect(note.mentionedGroupIds).toEqual([]);
      expect(note.text).not.toContain('@');
    } finally {
      await CrmLeadGroup.deleteOne({ _id: foreignGroupId });
    }
  });

  it('suppresses the note\'s own notification only once the task notification is confirmed to have reached the same rep, even after an initial failure and retry', async () => {
    const f = await fixture('sms');
    const check = await begin(f);
    const spy = jest.spyOn(notificationService, 'createNotification').mockRejectedValueOnce(new Error('local delivery failure'));
    await expect(screenAiHumanAttention(check)).rejects.toThrow('local delivery failure');
    expect(await Lead.findById(f.leadId).lean().then((l: any) => l?.notes?.length || 0)).toBe(0);
    await screenAiHumanAttention(check);
    spy.mockRestore();
    const lead: any = await Lead.findById(f.leadId).lean();
    expect(lead?.notes).toHaveLength(1);
    expect(await Notification.countDocuments({ type: 'lead_note_mention', 'metadata.leadId': f.leadId })).toBe(0);
    expect(await Notification.countDocuments({ type: 'ai_agent_handoff_needed', 'metadata.leadId': f.leadId })).toBe(1);
  });

  it('treats a cross-org assignee as no valid assignee for the note too (task falls back to org admins, note mentions nobody, never leaks the foreign id)', async () => {
    const f = await fixture('webchat', ids.foreign);
    await screenAiHumanAttention(await begin(f));
    expect(await Notification.countDocuments({ type: 'ai_agent_handoff_needed', 'metadata.leadId': f.leadId })).toBeGreaterThan(0);
    const lead: any = await Lead.findById(f.leadId).lean();
    expect(lead?.notes).toHaveLength(1);
    const note = lead.notes[0];
    expect(note.mentionedUserIds).toEqual([]);
    expect(note.mentionedGroupIds).toEqual([]);
    expect(note.text).not.toContain(String(ids.foreign));
    expect(await Notification.countDocuments({ type: 'lead_note_mention', userId: ids.foreign })).toBe(0);
  });

  it('a failed note write leaves a fresh claim in place and does NOT retry on an immediate next event (avoids a risky double-attempt while the outcome is still ambiguous)', async () => {
    const f = await fixture('sms');
    const spy = jest.spyOn(leadNoteModule, 'addLeadNoteAndNotify').mockRejectedValueOnce(new Error('local note-write failure'));
    const check = await begin(f);
    await screenAiHumanAttention(check);
    expect(await Lead.findById(f.leadId).lean().then((l: any) => l?.notes?.length || 0)).toBe(0);
    const task: any = await AiAgentTask.findOne({ leadId: f.leadId }).lean();
    expect(task?.notificationsCompletedAt).toBeInstanceOf(Date);
    expect(task?.noteCreatedAt).toBeUndefined();
    expect(task?.noteClaimedAt).toBeInstanceOf(Date);
    const state: any = await Conversation.findById(f.targetId).lean();
    expect(state?.aiPausedAt).toBeInstanceOf(Date);

    spy.mockRestore();
    const next = await begin(f, 'Anyone there?');
    await screenAiHumanAttention(next);
    expect(await Lead.findById(f.leadId).lean().then((l: any) => l?.notes?.length || 0)).toBe(0);
  });

  it('recovers and writes exactly one note once the stale claim window has passed (crash-recovery: scenario where the claim was acquired but the process never finished)', async () => {
    const f = await fixture('sms');
    const spy = jest.spyOn(leadNoteModule, 'addLeadNoteAndNotify').mockRejectedValueOnce(new Error('local note-write failure'));
    const check = await begin(f);
    await screenAiHumanAttention(check);
    spy.mockRestore();

    const task: any = await AiAgentTask.findOne({ leadId: f.leadId }).lean();
    await AiAgentTask.updateOne({ _id: task._id }, { $set: { noteClaimedAt: new Date(Date.now() - 11 * 60 * 1000) } });

    const next = await begin(f, 'Anyone there?');
    await screenAiHumanAttention(next);
    const lead: any = await Lead.findById(f.leadId).lean();
    expect(lead?.notes).toHaveLength(1);
    expect(String(lead.notes[0].sourceTaskId)).toBe(String(task._id));
    const finalTask: any = await AiAgentTask.findById(task._id).lean();
    expect(finalTask?.noteCreatedAt).toBeInstanceOf(Date);
  });

  it('never creates a duplicate note when the write actually succeeded but the task bookkeeping was never confirmed (ambiguous client-side error/timeout)', async () => {
    const f = await fixture('sms');
    const check = await begin(f);
    await screenAiHumanAttention(check);
    const task: any = await AiAgentTask.findOne({ leadId: f.leadId }).lean();
    const leadBefore: any = await Lead.findById(f.leadId).lean();
    expect(leadBefore?.notes).toHaveLength(1);
    expect(leadBefore.notes[0].sourceTaskId).toBeTruthy();

    await AiAgentTask.updateOne({ _id: task._id }, { $set: { noteClaimedAt: new Date(Date.now() - 11 * 60 * 1000) }, $unset: { noteCreatedAt: '' } });

    const next = await begin(f, 'Still there?');
    await screenAiHumanAttention(next);
    const leadAfter: any = await Lead.findById(f.leadId).lean();
    expect(leadAfter?.notes).toHaveLength(1);
    const finalTask: any = await AiAgentTask.findById(task._id).lean();
    expect(finalTask?.noteCreatedAt).toBeInstanceOf(Date);
  });

  it('never produces a duplicate note even if a claim is acquired twice in a row with no real work in between (defense in depth alongside the concurrent-attempt guard)', async () => {
    const f = await fixture('sms');
    const check = await begin(f);
    await screenAiHumanAttention(check);
    const task: any = await AiAgentTask.findOne({ leadId: f.leadId }).lean();

    for (let i = 0; i < 3; i++) {
      await AiAgentTask.updateOne({ _id: task._id }, { $set: { noteClaimedAt: new Date(Date.now() - 11 * 60 * 1000) } });
      const retry = await begin(f, `Follow-up ${i}`);
      await screenAiHumanAttention(retry);
    }
    const lead: any = await Lead.findById(f.leadId).lean();
    expect(lead?.notes).toHaveLength(1);
  });

  it('never creates a note or task outside the Alex webchat/SMS channels, and never produces an outbound customer-facing message', async () => {
    intent = 'human_request';
    const f = await fixture('sms');
    await screenAiHumanAttention(await begin(f, 'Let me talk to a real person.'));
    expect(mockSms).not.toHaveBeenCalled();
    expect(await CommunicationMessage.countDocuments({ conversationId: f.targetId, direction: 'outbound' })).toBe(0);
    const lead: any = await Lead.findById(f.leadId).lean();
    expect(lead?.notes).toHaveLength(1);
  });
});
