const mockCreate = jest.fn();
jest.mock('openai', () => jest.fn().mockImplementation(() => ({ chat: { completions: { create: mockCreate } } })));

const mockEmitToOrg = jest.fn();
const mockEmitToUser = jest.fn();
jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: mockEmitToOrg, emitToUser: mockEmitToUser }));
const mockNotifyUsers = jest.fn();
const mockNotifyOrgAdmins = jest.fn();
jest.mock('../src/utils/safeNotification', () => ({ notifyUsers: mockNotifyUsers, notifyOrgAdmins: mockNotifyOrgAdmins, safeCreateNotification: jest.fn() }));
const mockSendSms = jest.fn();
jest.mock('../src/services/telnyx.service', () => ({ __esModule: true, default: { sendSms: mockSendSms }, sendSms: mockSendSms }));
const mockSendEmail = jest.fn();
jest.mock('../src/services/email.service', () => ({ __esModule: true, default: { sendEmail: mockSendEmail } }));
const mockLog = jest.fn();
jest.mock('../src/utils/logger', () => {
  const log: any = { info: mockLog, warn: mockLog, error: mockLog, debug: mockLog, trace: mockLog, fatal: mockLog };
  log.child = () => log;
  return { __esModule: true, default: log };
});

process.env.GEMINI_API_KEY = 'test-key';
process.env.LOCAL_UI_ACCEPTANCE_MODE = '';
process.env.AI_AGENT_GENERATION_TIMEOUT_MS = '400';

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import AiAgentDraft from '../src/models/AiAgentDraft.model';
import AiUsageCounter from '../src/models/AiUsageCounter.model';
import Lead from '../src/models/lead.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import AiAgentCoachingRule from '../src/models/AiAgentCoachingRule.model';
import AiAgentTask from '../src/models/AiAgentTask.model';
import AiAgentLog from '../src/models/AiAgentLog.model';
import Notification from '../src/models/Notification.model';
import { normalizeIdentityPhone, normalizeIdentityEmail } from '../src/utils/contactIdentity';
import { CLARIFYING_QUESTION_MARKER } from '../src/services/vehicleInquiryContext.service';
import {
  generateShadowDraft,
  recoverStaleShadowDrafts,
  shadowDraftUsageDay,
  SHADOW_DRAFT_FALLBACK_TIMEZONE,
} from '../src/services/aiShadowDraft.service';

const CUSTOMER_SECRET = 'ZEBRA-CUSTOMER-SECRET';
const DRAFT_SECRET = 'ZEBRA-DRAFT-SECRET';
const TRAINING = { aiShadowDraftsEnabled: true, aiAgentName: 'Alex', aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } };

type Phase = 'generation' | 'classifier' | 'selection' | 'compliance';
type Handler = (body: any, req: any) => Promise<any>;

const reply = (content: string, usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }) =>
  Promise.resolve({ model: 'gemini-test-model', choices: [{ message: { content } }], usage });

const hang: Handler = (_body, req) => new Promise((_resolve, reject) => {
  const signal: AbortSignal | undefined = req?.signal;
  if (!signal) return;
  signal.addEventListener('abort', () => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' })));
});

function phaseOf(body: any): Phase {
  const system = String(body?.messages?.[0]?.content || '');
  if (system.includes('strict compliance classifier')) return 'classifier';
  if (system.includes('You select dealership coaching rules')) return 'selection';
  if (system.includes('You check whether one AI dealership assistant reply')) return 'compliance';
  return 'generation';
}

const defaults: Record<Phase, Handler> = {
  generation: () => reply(`Thanks Jordan! ${DRAFT_SECRET} I will check with the team and follow up shortly.`, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
  classifier: () => reply('SAFE', { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 }),
  selection: () => reply('{"relevantRuleIds":[],"suppressed":[]}'),
  compliance: () => reply('{"verdict":"compliant","violatedRuleIds":[]}'),
};

let handlers: Record<Phase, Handler>;
let calls: Array<{ phase: Phase; system: string; signal?: AbortSignal }>;

describe('Real-DB proof: shadow draft generation with mocked Gemini (local dev MongoDB only)', () => {
  const env = { ...process.env };
  let org: any;
  const creator = new mongoose.Types.ObjectId();
  let threadCounter = 0;

  async function seedLead(overrides: any = {}) {
    const doc: any = {
      _id: new mongoose.Types.ObjectId(),
      organizationId: org._id,
      createdBy: creator,
      firstName: 'Jordan',
      lastName: 'Shadow',
      phone: '8015550142',
      normalizedPhone: normalizeIdentityPhone('8015550142'),
      email: 'jordan.shadow@example.com',
      normalizedEmail: normalizeIdentityEmail('jordan.shadow@example.com'),
      vehicle: { year: '2022', make: 'Toyota', model: 'Camry' },
      status: 'New',
      notes: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    await Lead.collection.insertOne(doc);
    return doc;
  }

  async function seedSmsThread(lead: any, messages: Array<{ direction: 'inbound' | 'outbound'; body: string; ai?: boolean }>) {
    const conversationId = new mongoose.Types.ObjectId();
    await Conversation.collection.insertOne({
      _id: conversationId, orgId: org._id, customerPhone: `+1801555${String(1000 + (threadCounter++ % 9000))}`, leadId: lead._id, messageCount: messages.length, lastMessageAt: new Date(),
    } as any);
    let lastId = '';
    let at = Date.now() - messages.length * 1000;
    for (const message of messages) {
      const _id = new mongoose.Types.ObjectId();
      lastId = String(_id);
      await CommunicationMessage.collection.insertOne({
        _id, orgId: org._id, conversationId, leadId: lead._id, direction: message.direction, body: message.body,
        from: message.direction === 'inbound' ? '+1' + lead.phone : '+18015550100',
        to: message.direction === 'inbound' ? '+18015550100' : '+1' + lead.phone,
        sentBy: message.ai ? { userId: 'ai-agent', name: 'Alex' } : undefined,
        createdAt: new Date((at += 1000)),
      } as any);
    }
    return { conversationId, lastId };
  }

  function smsInput(lead: any, thread: { conversationId: any; lastId: string }, extra: any = {}) {
    return {
      organizationId: org._id,
      channel: 'sms' as const,
      sourceMessageId: thread.lastId,
      sourceMessageModel: 'CommunicationMessage' as const,
      leadId: lead._id,
      conversationId: thread.conversationId,
      inquiryReceivedAt: new Date(),
      lead,
      phone: lead.phone,
      ...extra,
    };
  }

  async function smsDraft(extra: any = {}) {
    const lead = await seedLead();
    const thread = await seedSmsThread(lead, [{ direction: 'inbound', body: `Hi, is the Camry still around? ${CUSTOMER_SECRET}` }]);
    return { lead, thread, input: smsInput(lead, thread, extra) };
  }

  const draftFor = (sourceMessageId: string) => AiAgentDraft.findOne({ organizationId: String(org._id), sourceMessageId }).lean();
  const phases = () => calls.map((call) => call.phase);

  beforeAll(async () => {
    await AiAgentDraft.init();
    await AiUsageCounter.init();
    org = await Organization.create({ name: 'Shadow Motors', slug: 'shadow-gen-' + Date.now(), status: 'active', metadata: { ...TRAINING } });
  });

  afterAll(async () => {
    const orgId = String(org._id);
    await AiAgentDraft.deleteMany({ organizationId: orgId });
    await AiUsageCounter.deleteMany({ organizationId: orgId });
    await Lead.collection.deleteMany({ organizationId: org._id });
    await Conversation.collection.deleteMany({ orgId: org._id });
    await CommunicationMessage.collection.deleteMany({ orgId: org._id });
    await WebChatSession.collection.deleteMany({ organizationId: orgId });
    await WebChatMessage.collection.deleteMany({ organizationId: orgId });
    await AiAgentCoachingRule.collection.deleteMany({ organizationId: orgId });
    await Organization.deleteOne({ _id: org._id });
    process.env = env;
  });

  beforeEach(async () => {
    process.env.AI_AGENT_ENABLED = 'true';
    process.env.AI_SHADOW_DRAFTS_ENABLED = 'true';
    delete process.env.AI_SHADOW_DRAFT_DEADLINE_MS;
    delete process.env.AI_SHADOW_DRAFT_CALL_TIMEOUT_MS;
    delete process.env.AI_SHADOW_DRAFT_MAX_AI_CALLS;
    const orgId = String(org._id);
    await AiAgentDraft.deleteMany({ organizationId: orgId });
    await AiUsageCounter.deleteMany({ organizationId: orgId });
    await Lead.collection.deleteMany({ organizationId: org._id });
    await Conversation.collection.deleteMany({ orgId: org._id });
    await CommunicationMessage.collection.deleteMany({ orgId: org._id });
    await AiAgentCoachingRule.collection.deleteMany({ organizationId: orgId });
    await Organization.updateOne({ _id: org._id }, { $set: { metadata: { ...TRAINING } } });
    handlers = { ...defaults };
    calls = [];
    mockCreate.mockReset();
    mockCreate.mockImplementation((body: any, req: any) => {
      const phase = phaseOf(body);
      calls.push({ phase, system: String(body?.messages?.[0]?.content || ''), signal: req?.signal });
      return handlers[phase](body, req);
    });
    for (const mock of [mockEmitToOrg, mockEmitToUser, mockNotifyUsers, mockNotifyOrgAdmins, mockSendSms, mockSendEmail, mockLog]) mock.mockClear();
  });

  afterEach(() => {
    expect(mockEmitToOrg).not.toHaveBeenCalled();
    expect(mockEmitToUser).not.toHaveBeenCalled();
    expect(mockNotifyUsers).not.toHaveBeenCalled();
    expect(mockNotifyOrgAdmins).not.toHaveBeenCalled();
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
    const logged = JSON.stringify(mockLog.mock.calls);
    expect(logged).not.toContain(CUSTOMER_SECRET);
    expect(logged).not.toContain(DRAFT_SECRET);
  });

  it('SMS success: stores a private ready draft with references only, model, latency and summed tokens', async () => {
    const { input, thread } = await smsDraft();
    const result = await generateShadowDraft(input);
    expect(result).toMatchObject({ outcome: 'completed', status: 'ready' });

    const draft: any = await draftFor(thread.lastId);
    expect(draft).toMatchObject({
      status: 'ready', kind: 'reply', channel: 'sms', sourceMessageModel: 'CommunicationMessage',
      deterministicOk: true, classifierVerdict: 'SAFE', coachingVerdict: 'not_applicable',
      aiModel: 'gemini-test-model', aiCallCount: 2, promptTokens: 17, completionTokens: 6, totalTokens: 23,
      wouldHaveBeenCapped: false,
    });
    expect(draft.draftText).toContain(DRAFT_SECRET);
    expect(typeof draft.latencyMs).toBe('number');
    expect(draft.leaseId).toBeUndefined();
    expect(JSON.stringify(draft)).not.toContain(CUSTOMER_SECRET);
    expect(phases()).toEqual(['generation', 'classifier']);
    expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
  });

  it('webchat success reads the webchat transcript and stores a ready draft', async () => {
    const lead = await seedLead();
    const sessionId = new mongoose.Types.ObjectId();
    await WebChatSession.collection.insertOne({ _id: sessionId, organizationId: String(org._id), leadId: lead._id, tokenHash: 'test', visitorName: 'Jordan' } as any);
    const messageId = new mongoose.Types.ObjectId();
    await WebChatMessage.collection.insertOne({ _id: messageId, organizationId: String(org._id), sessionId, leadId: lead._id, direction: 'inbound', body: `Do you have SUVs? ${CUSTOMER_SECRET}`, createdAt: new Date() } as any);

    const result = await generateShadowDraft({
      organizationId: org._id, channel: 'webchat', sourceMessageId: String(messageId), sourceMessageModel: 'WebChatMessage',
      leadId: lead._id, sessionId, inquiryReceivedAt: new Date(), lead,
    });
    expect(result).toMatchObject({ outcome: 'completed', status: 'ready' });
    const draft: any = await draftFor(String(messageId));
    expect(draft).toMatchObject({ channel: 'webchat', sessionId, status: 'ready', classifierVerdict: 'SAFE' });
    expect(calls.find((call) => call.phase === 'generation')!.system).toContain('website chat');
  });

  it('email first inquiry uses only the supplied inquiry text and the email classifier', async () => {
    const lead = await seedLead();
    const result = await generateShadowDraft({
      organizationId: org._id, channel: 'email', sourceMessageId: String(lead._id), sourceMessageModel: 'Lead',
      leadId: lead._id, inquiryReceivedAt: new Date(), lead, inquiryText: `Is the Camry available this weekend? ${CUSTOMER_SECRET}`,
    });
    expect(result).toMatchObject({ outcome: 'completed', status: 'ready' });
    const draft: any = await draftFor(String(lead._id));
    expect(draft).toMatchObject({ channel: 'email', status: 'ready', classifierVerdict: 'SAFE', coachingVerdict: 'not_applicable' });
    expect(calls.find((call) => call.phase === 'classifier')!.system).toContain('EMAIL');
    expect(JSON.stringify(draft)).not.toContain(CUSTOMER_SECRET);
  });

  it('email without inquiry text fails without calling Gemini', async () => {
    const lead = await seedLead();
    const result = await generateShadowDraft({
      organizationId: org._id, channel: 'email', sourceMessageId: String(lead._id), sourceMessageModel: 'Lead', leadId: lead._id, lead,
    });
    expect(result).toMatchObject({ outcome: 'failed', status: 'failed', reason: 'No inquiry text was provided for the email draft' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('ambiguous vehicle: stores the safe clarifying question with no AI call', async () => {
    const lead = await seedLead();
    await seedLead({ vehicle: { year: '2021', make: 'Honda', model: 'Pilot' } });
    const thread = await seedSmsThread(lead, [{ direction: 'inbound', body: `Is it still available? ${CUSTOMER_SECRET}` }]);
    const result = await generateShadowDraft(smsInput(lead, thread));
    expect(result).toMatchObject({ outcome: 'completed', status: 'ready' });
    const draft: any = await draftFor(thread.lastId);
    expect(draft).toMatchObject({ kind: 'vehicle_clarification', vehicleResolution: 'ambiguous', deterministicOk: true, aiCallCount: 0 });
    expect(draft.draftText).toContain(CLARIFYING_QUESTION_MARKER);
    expect(draft.draftText).toContain('Camry');
    expect(draft.draftText).toContain('Pilot');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('ambiguous vehicle after an earlier clarifying question goes to a human instead of asking again', async () => {
    const lead = await seedLead();
    await seedLead({ vehicle: { year: '2021', make: 'Honda', model: 'Pilot' } });
    const thread = await seedSmsThread(lead, [
      { direction: 'inbound', body: 'Is it still available?' },
      { direction: 'outbound', body: `Thanks! ${CLARIFYING_QUESTION_MARKER}, are you asking about the 2022 Toyota Camry or the 2021 Honda Pilot?`, ai: true },
      { direction: 'inbound', body: `the one I asked about ${CUSTOMER_SECRET}` },
    ]);
    await generateShadowDraft(smsInput(lead, thread));
    const draft: any = await draftFor(thread.lastId);
    expect(draft).toMatchObject({ status: 'needs_human', kind: 'vehicle_clarification', vehicleResolution: 'ambiguous' });
    expect(draft.draftText).toBeUndefined();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('classifier UNSAFE blocks the draft and keeps the private text for review', async () => {
    handlers.classifier = () => reply('UNSAFE');
    const { input, thread } = await smsDraft();
    await generateShadowDraft(input);
    const draft: any = await draftFor(thread.lastId);
    expect(draft).toMatchObject({ status: 'blocked_safety', classifierVerdict: 'UNSAFE', deterministicOk: true });
    expect(draft.draftText).toContain(DRAFT_SECRET);
  });

  it('a deterministic violation blocks the draft before the classifier is called', async () => {
    handlers.generation = () => reply('Great news, it is $500 off today only!');
    const { input, thread } = await smsDraft();
    await generateShadowDraft(input);
    const draft: any = await draftFor(thread.lastId);
    expect(draft.status).toBe('blocked_safety');
    expect(draft.deterministicOk).toBe(false);
    expect(draft.deterministicReasons.length).toBeGreaterThan(0);
    expect(draft.classifierVerdict).toBeUndefined();
    expect(phases()).toEqual(['generation']);
  });

  it('a handoff marker becomes needs_human and never creates a task', async () => {
    handlers.generation = () => reply('Let me confirm where that vehicle is parked and follow up.\n[[HANDOFF: confirm vehicle location]]');
    const { input, thread } = await smsDraft();
    const tasksBefore = await AiAgentTask.countDocuments({});
    await generateShadowDraft(input);
    const draft: any = await draftFor(thread.lastId);
    expect(draft).toMatchObject({ status: 'needs_human', handoffReason: 'confirm vehicle location', classifierVerdict: 'SAFE' });
    expect(draft.draftText).not.toContain('[[HANDOFF');
    expect(await AiAgentTask.countDocuments({})).toBe(tasksBefore);
  });

  it('unsafe wins over a handoff', async () => {
    handlers.generation = () => reply('Let me check on that for you.\n[[HANDOFF: pricing question]]');
    handlers.classifier = () => reply('UNSAFE');
    const { input, thread } = await smsDraft();
    await generateShadowDraft(input);
    expect((await draftFor(thread.lastId) as any).status).toBe('blocked_safety');
  });

  it('a generation provider failure marks the draft failed', async () => {
    handlers.generation = () => Promise.reject(Object.assign(new Error('upstream exploded'), { status: 500 }));
    const { input, thread } = await smsDraft();
    const result = await generateShadowDraft(input);
    expect(result).toMatchObject({ outcome: 'failed', status: 'failed' });
    const draft: any = await draftFor(thread.lastId);
    expect(draft.status).toBe('failed');
    expect(draft.failureReason).toBeTruthy();
    expect(draft.draftText).toBeUndefined();
  });

  it('a classifier failure fails closed as blocked_safety with verdict ERROR', async () => {
    handlers.classifier = () => Promise.reject(new Error('classifier down'));
    const { input, thread } = await smsDraft();
    await generateShadowDraft(input);
    expect(await draftFor(thread.lastId)).toMatchObject({ status: 'blocked_safety', classifierVerdict: 'ERROR' });
  });

  it('a generation timeout fails the draft and cancels the still-running request', async () => {
    handlers.generation = hang;
    const { input, thread } = await smsDraft();
    const result = await generateShadowDraft(input);
    expect(result).toMatchObject({ outcome: 'failed', status: 'failed' });
    expect((await draftFor(thread.lastId) as any).failureReason).toMatch(/too long/i);
    const generationCall = calls.find((call) => call.phase === 'generation')!;
    expect(generationCall.signal!.aborted).toBe(true);
  });

  it('the overall deadline aborts in-flight work and records a timeout', async () => {
    process.env.AI_SHADOW_DRAFT_DEADLINE_MS = '150';
    handlers.generation = hang;
    const { input, thread } = await smsDraft();
    const started = Date.now();
    const result = await generateShadowDraft(input);
    expect(Date.now() - started).toBeLessThan(400);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'Generation timed out and was cancelled' });
    expect((await draftFor(thread.lastId) as any).failureReason).toBe('Generation timed out and was cancelled');
    expect(calls[0].signal!.aborted).toBe(true);
  });

  it('a per-call timeout cancels a hung classifier and fails closed', async () => {
    process.env.AI_SHADOW_DRAFT_CALL_TIMEOUT_MS = '100';
    handlers.classifier = hang;
    const { input, thread } = await smsDraft();
    await generateShadowDraft(input);
    expect(await draftFor(thread.lastId)).toMatchObject({ status: 'blocked_safety', classifierVerdict: 'ERROR' });
    expect(calls.find((call) => call.phase === 'classifier')!.signal!.aborted).toBe(true);
  });

  it('the AI call budget is enforced and an exhausted budget fails the draft', async () => {
    process.env.AI_SHADOW_DRAFT_MAX_AI_CALLS = '1';
    const { input, thread } = await smsDraft();
    const result = await generateShadowDraft(input);
    expect(result).toMatchObject({ outcome: 'failed', reason: 'AI call budget for this draft was exceeded' });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect((await draftFor(thread.lastId) as any).draftText).toBeUndefined();
  });

  it('two concurrent calls for the same message produce one draft and one generation', async () => {
    const { input, thread } = await smsDraft();
    const results = await Promise.all([generateShadowDraft(input), generateShadowDraft(input)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['completed', 'duplicate']);
    expect(phases().filter((phase) => phase === 'generation')).toHaveLength(1);
    expect(await AiAgentDraft.countDocuments({ organizationId: String(org._id), sourceMessageId: thread.lastId })).toBe(1);
  });

  it('cap exhaustion skips without calling Gemini', async () => {
    const day = shadowDraftUsageDay(SHADOW_DRAFT_FALLBACK_TIMEZONE);
    await AiUsageCounter.create({ organizationId: String(org._id), day, kind: 'shadow_draft', count: 100 });
    const { input, thread } = await smsDraft();
    const result = await generateShadowDraft(input);
    expect(result).toMatchObject({ outcome: 'not_started', status: 'skipped_cap' });
    expect(mockCreate).not.toHaveBeenCalled();
    expect((await draftFor(thread.lastId) as any).status).toBe('skipped_cap');
  });

  it('10 concurrent generations with 3 slots left only ever generate 3', async () => {
    const day = shadowDraftUsageDay(SHADOW_DRAFT_FALLBACK_TIMEZONE);
    await AiUsageCounter.create({ organizationId: String(org._id), day, kind: 'shadow_draft', count: 97 });
    const lead = await seedLead();
    const inputs = [];
    for (let i = 0; i < 10; i++) inputs.push(smsInput(lead, await seedSmsThread(lead, [{ direction: 'inbound', body: `Message ${i}` }])));
    const results = await Promise.all(inputs.map((input) => generateShadowDraft(input)));
    expect(results.filter((r) => r.outcome === 'completed')).toHaveLength(3);
    expect(results.filter((r) => r.outcome === 'not_started' && r.status === 'skipped_cap')).toHaveLength(7);
    expect(phases().filter((phase) => phase === 'generation')).toHaveLength(3);
    const counter: any = await AiUsageCounter.findOne({ organizationId: String(org._id), day, kind: 'shadow_draft' }).lean();
    expect(counter.count).toBe(100);
  });

  it('a worker that lost its lease cannot write its result', async () => {
    const { input, thread } = await smsDraft();
    handlers.generation = async () => {
      await AiAgentDraft.updateOne({ organizationId: String(org._id), sourceMessageId: thread.lastId }, { $set: { leaseId: 'another-worker' } });
      return reply(`Taken over ${DRAFT_SECRET}`);
    };
    const result = await generateShadowDraft(input);
    expect(result).toMatchObject({ outcome: 'completed', status: 'lost_lease' });
    const draft: any = await draftFor(thread.lastId);
    expect(draft).toMatchObject({ status: 'generating', leaseId: 'another-worker' });
    expect(draft.draftText).toBeUndefined();
  });

  it('an expired worker recovered as stale cannot overwrite the recovered row', async () => {
    const { input, thread } = await smsDraft();
    handlers.generation = async () => {
      await AiAgentDraft.updateOne({ organizationId: String(org._id), sourceMessageId: thread.lastId }, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } });
      await recoverStaleShadowDrafts(org._id);
      return reply(`Late result ${DRAFT_SECRET}`);
    };
    const result = await generateShadowDraft(input);
    expect(result).toMatchObject({ outcome: 'completed', status: 'lost_lease' });
    const draft: any = await draftFor(thread.lastId);
    expect(draft.status).toBe('failed');
    expect(draft.failureReason).toMatch(/Abandoned during generation/);
    expect(draft.draftText).toBeUndefined();
  });

  it.each([
    ['the channel leaves Training', { 'metadata.aiAgentModes.sms': 'live' }, null],
    ['the admin disables shadow drafts', { 'metadata.aiShadowDraftsEnabled': false }, null],
    ['the global flag is turned off', null, 'AI_SHADOW_DRAFTS_ENABLED'],
    ['the AI master switch is turned off', null, 'AI_AGENT_ENABLED'],
  ])('generated text is discarded when %s mid-generation', async (_label, orgChange, envFlag) => {
    const { input, thread } = await smsDraft();
    handlers.generation = async () => {
      if (orgChange) await Organization.updateOne({ _id: org._id }, { $set: orgChange as any });
      if (envFlag) delete process.env[envFlag as string];
      return reply(`Should be discarded ${DRAFT_SECRET}`);
    };
    const result = await generateShadowDraft(input);
    expect(result).toMatchObject({ outcome: 'completed', status: 'failed' });
    const draft: any = await draftFor(thread.lastId);
    expect(draft.status).toBe('failed');
    expect(draft.failureReason).toMatch(/^Discarded: no longer eligible/);
    expect(draft.draftText).toBeUndefined();
    expect(draft.classifierVerdict).toBeUndefined();
  });

  it('a channel that is not in Training never claims or calls Gemini', async () => {
    await Organization.updateOne({ _id: org._id }, { $set: { 'metadata.aiAgentModes.sms': 'testing' } });
    const { input, thread } = await smsDraft();
    expect(await generateShadowDraft(input)).toEqual({ outcome: 'ineligible', reason: 'mode_not_training' });
    expect(await draftFor(thread.lastId)).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('coaching is read-only: applied, checked once, no regeneration, usage counters untouched', async () => {
    const ruleId = new mongoose.Types.ObjectId();
    const lastUsedAt = new Date('2026-01-01T00:00:00Z');
    await AiAgentCoachingRule.collection.insertOne({
      _id: ruleId, organizationId: String(org._id), scope: 'organization', channel: 'all', status: 'active',
      instruction: 'Always mention our Saturday hours when inviting a visit.', sourceLeadId: new mongoose.Types.ObjectId(),
      sourceMessageId: new mongoose.Types.ObjectId(), sourceMessageModel: 'CommunicationMessage', originalAiMessageSnapshot: 'x',
      usageCount: 3, lastUsedAt, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    handlers.selection = () => reply(JSON.stringify({ relevantRuleIds: [String(ruleId)], suppressed: [] }));
    handlers.compliance = () => reply(JSON.stringify({ verdict: 'violates', violatedRuleIds: [String(ruleId)], reason: 'missing hours' }));
    const { input, thread } = await smsDraft();
    await generateShadowDraft(input);

    const draft: any = await draftFor(thread.lastId);
    expect(draft).toMatchObject({ status: 'ready', coachingVerdict: 'violates', coachingRuleIds: [String(ruleId)], aiCallCount: 4 });
    expect(phases()).toEqual(['selection', 'generation', 'compliance', 'classifier']);
    expect(calls.find((call) => call.phase === 'generation')!.system).toContain('Saturday hours');
    const rule: any = await AiAgentCoachingRule.findById(ruleId).lean();
    expect(rule.usageCount).toBe(3);
    expect(new Date(rule.lastUsedAt).getTime()).toBe(lastUsedAt.getTime());
  });

  it('a coaching selection failure goes to a human without generating', async () => {
    await AiAgentCoachingRule.collection.insertOne({
      organizationId: String(org._id), scope: 'organization', channel: 'sms', status: 'active', instruction: 'Be brief.',
      sourceLeadId: new mongoose.Types.ObjectId(), sourceMessageId: new mongoose.Types.ObjectId(), sourceMessageModel: 'CommunicationMessage',
      originalAiMessageSnapshot: 'x', usageCount: 0, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    handlers.selection = () => reply('not json at all');
    const { input, thread } = await smsDraft();
    await generateShadowDraft(input);
    expect(await draftFor(thread.lastId)).toMatchObject({ status: 'needs_human', coachingVerdict: 'error' });
    expect(phases()).toEqual(['selection']);
  });

  it('records whether live Alex would have hit its reply caps', async () => {
    const lead = await seedLead();
    const messages: any[] = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ direction: 'inbound', body: `question ${i}` });
      messages.push({ direction: 'outbound', body: `answer ${i}`, ai: true });
    }
    messages.push({ direction: 'inbound', body: 'one more thing' });
    const thread = await seedSmsThread(lead, messages);
    await generateShadowDraft(smsInput(lead, thread));
    expect((await draftFor(thread.lastId) as any).wouldHaveBeenCapped).toBe(true);
  });

  it('touches no live records: messages, threads, sessions, tasks, notifications, logs, lead, coaching', async () => {
    const ruleId = new mongoose.Types.ObjectId();
    await AiAgentCoachingRule.collection.insertOne({
      _id: ruleId, organizationId: String(org._id), scope: 'organization', channel: 'all', status: 'active', instruction: 'Be warm.',
      sourceLeadId: new mongoose.Types.ObjectId(), sourceMessageId: new mongoose.Types.ObjectId(), sourceMessageModel: 'CommunicationMessage',
      originalAiMessageSnapshot: 'x', usageCount: 0, createdAt: new Date(), updatedAt: new Date(),
    } as any);
    handlers.selection = () => reply(JSON.stringify({ relevantRuleIds: [String(ruleId)], suppressed: [] }));
    handlers.generation = () => reply('Let me get the details for you.\n[[HANDOFF: needs a person]]');
    const { lead, thread, input } = await smsDraft();
    const sessionId = new mongoose.Types.ObjectId();
    await WebChatSession.collection.insertOne({ _id: sessionId, organizationId: String(org._id), leadId: lead._id, tokenHash: 't', visitorName: 'J' } as any);

    const snapshot = async () => ({
      messages: await CommunicationMessage.collection.find({ orgId: org._id }).toArray(),
      conversation: await Conversation.collection.findOne({ _id: thread.conversationId }),
      webchatMessages: await WebChatMessage.collection.countDocuments({ organizationId: String(org._id) }),
      session: await WebChatSession.collection.findOne({ _id: sessionId }),
      lead: await Lead.collection.findOne({ _id: lead._id }),
      rule: await AiAgentCoachingRule.collection.findOne({ _id: ruleId }),
      tasks: await AiAgentTask.countDocuments({}),
      notifications: await Notification.countDocuments({}),
      aiLogs: await AiAgentLog.countDocuments({}),
    });
    const before = await snapshot();
    await generateShadowDraft(input);
    const after = await snapshot();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(await draftFor(thread.lastId)).toMatchObject({ status: 'needs_human' });
  });
});
