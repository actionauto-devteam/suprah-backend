const mockLeadCreate = jest.fn();
const mockLeadFindOne = jest.fn();
const mockLeadUpdateOne = jest.fn().mockResolvedValue({});
const mockUserFindOne = jest.fn();
const mockOrgFindOne = jest.fn();
const mockOrgFindById = jest.fn();
const mockSessionCreate = jest.fn();
const mockSessionFindOneAndUpdate = jest.fn();
const mockSessionUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageCreate = jest.fn();
const mockMessageExists = jest.fn();
const mockMessageDeleteOne = jest.fn().mockResolvedValue({});
const mockMessageUpdateOne = jest.fn().mockResolvedValue({});
const mockMessageCountDocuments = jest.fn().mockResolvedValue(0);
const mockMessageFind = jest.fn();
const mockEmitToOrg = jest.fn();
const mockResolveAiChannelMode = jest.fn();
const mockDecideAiDelivery = jest.fn();
const mockAssertAiDispatchAllowed = jest.fn();
const mockScreen = jest.fn();
const mockFinish = jest.fn().mockResolvedValue(undefined);
const mockClaimGeneration = jest.fn();
const mockClaimDispatch = jest.fn().mockResolvedValue(undefined);
const mockProcessAlexTurn = jest.fn();
const mockResolveDealerName = jest.fn().mockResolvedValue('Action Auto');

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { create: mockLeadCreate, findOne: mockLeadFindOne, updateOne: mockLeadUpdateOne },
}));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findOne: mockUserFindOne } }));
jest.mock('../../src/models/Vehicle.model', () => ({ __esModule: true, default: { findById: jest.fn() } }));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findOne: mockOrgFindOne, findById: mockOrgFindById },
}));
jest.mock('../../src/models/WebChatSession.model', () => ({
  __esModule: true,
  default: { create: mockSessionCreate, findOneAndUpdate: mockSessionFindOneAndUpdate, updateOne: mockSessionUpdateOne },
}));
jest.mock('../../src/models/WebChatMessage.model', () => ({
  __esModule: true,
  default: {
    create: mockMessageCreate,
    exists: mockMessageExists,
    deleteOne: mockMessageDeleteOne,
    updateOne: mockMessageUpdateOne,
    countDocuments: mockMessageCountDocuments,
    find: mockMessageFind,
  },
}));
jest.mock('../../src/models/IntakeClaim.model', () => ({ __esModule: true, default: { findOneAndUpdate: jest.fn(), updateOne: jest.fn() } }));
jest.mock('../../src/utils/socketEmitter', () => ({ __esModule: true, emitToOrg: mockEmitToOrg }));
jest.mock('../../src/utils/safeNotification', () => ({ __esModule: true, notifyOrgAdmins: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/utils/notificationTemplates', () => ({
  __esModule: true,
  notificationTemplates: { new_lead: jest.fn().mockReturnValue({ title: 't', message: 'm' }) },
}));
jest.mock('../../src/utils/aiAgentTask', () => ({ __esModule: true, createAiAgentTaskAndNotify: jest.fn() }));
jest.mock('../../src/utils/leadNote', () => ({ __esModule: true, addLeadNoteAndNotify: jest.fn(), shouldSuppressHandoffNoteNotification: jest.fn() }));
jest.mock('../../src/utils/aiAutoPause', () => ({ __esModule: true, recordHumanTakeover: jest.fn() }));
jest.mock('../../src/utils/sendingWindow', () => ({ __esModule: true, isWithinSendingHours: jest.fn().mockReturnValue(true) }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../src/services/communication.service', () => ({ __esModule: true, resolveDealerName: mockResolveDealerName }));
jest.mock('../../src/services/aiAgentCoaching.service', () => ({
  __esModule: true,
  getRelevantAiCoaching: jest.fn().mockResolvedValue({ notes: [], ids: [], rules: [] }),
}));
jest.mock('../../src/services/aiAgent.service', () => ({
  __esModule: true,
  resolveAiAgentSettings: jest.fn().mockResolvedValue({ enabled: true, agentName: 'Alex' }),
  processAlexTurn: mockProcessAlexTurn,
  HISTORY_LIMIT: 12,
}));
jest.mock('../../src/services/aiHumanAttention.service', () => ({
  beginAiAttentionCheck: jest.fn().mockImplementation(async (input: any) => ({ ...input, version: 1 })),
  finishAiAttentionCheck: mockFinish,
  screenAiHumanAttention: mockScreen,
  canSendAiReply: jest.fn().mockResolvedValue(true),
  assertAiReplyAllowed: jest.fn().mockResolvedValue(undefined),
  claimAiGeneration: mockClaimGeneration,
  claimAiReplyDispatch: mockClaimDispatch,
}));
jest.mock('../../src/services/aiOperatingMode.service', () => ({
  __esModule: true,
  resolveAiChannelMode: mockResolveAiChannelMode,
  decideAiDelivery: mockDecideAiDelivery,
  assertAiDispatchAllowed: mockAssertAiDispatchAllowed,
  isAttentionScreeningMode: (mode: string) => mode !== 'off',
}));

import mongoose from 'mongoose';
import { startSession, sendWebchatUnavailableAck } from '../../src/controllers/webchat.controller';
import { AiReplySuppressedError } from '../../src/utils/aiReplySuppressed';
import { WEBCHAT_ACK_ACTOR_ID } from '../../src/utils/webchatAck';

const orgId = new mongoose.Types.ObjectId();
const leadId = new mongoose.Types.ObjectId();

async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function start() {
  const req: any = { body: { orgKey: 'action-auto', name: 'Jordan Lee', phone: '3855550123', message: 'Is the Civic available?' }, params: {} };
  const json = jest.fn();
  const res: any = { status: jest.fn(() => ({ json })), json };
  startSession(req, res, jest.fn());
  await flush();
}

function ackCreates() {
  return mockMessageCreate.mock.calls.filter(([doc]) => doc?.sentBy?.userId === WEBCHAT_ACK_ACTOR_ID);
}

describe('Website chat while Suprah AI is not live', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgFindOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: orgId }) }) });
    mockOrgFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Action Auto', metadata: { webchatEnabled: true } }) }) });
    mockUserFindOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'staff-1' }) }) }),
    });
    mockLeadCreate.mockResolvedValue({ _id: leadId, toObject: () => ({ _id: leadId }) });
    mockLeadFindOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ firstName: 'Jordan' }) }) });
    mockSessionCreate.mockResolvedValue({ _id: 'session-1', organizationId: String(orgId), leadId, visitorName: 'Jordan Lee', save: jest.fn() });
    mockMessageCreate.mockImplementation(async (doc: any) => ({ _id: `msg-${mockMessageCreate.mock.calls.length}`, createdAt: new Date(), ...doc }));
    mockMessageExists.mockResolvedValue(null);
    mockMessageFind.mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
    mockSessionFindOneAndUpdate.mockResolvedValue({ _id: 'session-1' });
    mockScreen.mockResolvedValue(true);
    mockClaimGeneration.mockResolvedValue({ aiGeneratingAt: new Date() });
  });

  it('in Training, still runs the customer-attention check, sends one accurate acknowledgement, and never runs Alex', async () => {
    mockResolveAiChannelMode.mockResolvedValue({ mode: 'training', source: 'configured' });
    mockDecideAiDelivery.mockResolvedValue({ action: 'skip', mode: 'training', source: 'configured' });
    await start();
    expect(mockScreen).toHaveBeenCalledTimes(1);
    expect(mockProcessAlexTurn).not.toHaveBeenCalled();
    expect(mockClaimGeneration).not.toHaveBeenCalled();
    const acks = ackCreates();
    expect(acks).toHaveLength(1);
    expect(acks[0][0]).toMatchObject({
      direction: 'outbound',
      body: "Thanks for reaching out to Action Auto! We've received your message, and a member of our team will get back to you as soon as possible.",
      sentBy: { userId: WEBCHAT_ACK_ACTOR_ID, name: 'Action Auto' },
    });
    expect(acks[0][0].aiDispatchPending).toBeUndefined();
    expect(mockLeadUpdateOne).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $set: expect.objectContaining({ 'followUp.lastRepResponseAt': expect.anything() }) }));
  });

  it('still acknowledges when the attention check flags a request for a human', async () => {
    mockResolveAiChannelMode.mockResolvedValue({ mode: 'training', source: 'configured' });
    mockScreen.mockResolvedValue(false);
    await start();
    expect(ackCreates()).toHaveLength(1);
    expect(mockProcessAlexTurn).not.toHaveBeenCalled();
  });

  it('when configured Off, skips the attention check but still acknowledges the visitor', async () => {
    mockResolveAiChannelMode.mockResolvedValue({ mode: 'off', source: 'configured' });
    await start();
    expect(mockScreen).not.toHaveBeenCalled();
    expect(ackCreates()).toHaveLength(1);
    expect(mockProcessAlexTurn).not.toHaveBeenCalled();
  });

  it('leaves a legacy org that never had AI on exactly as before: no acknowledgement, no attention check', async () => {
    mockResolveAiChannelMode.mockResolvedValue({ mode: 'off', source: 'legacy' });
    await start();
    expect(mockScreen).not.toHaveBeenCalled();
    expect(ackCreates()).toHaveLength(0);
    expect(mockFinish).toHaveBeenCalled();
  });

  it('when Live, runs Alex normally and sends no acknowledgement', async () => {
    mockResolveAiChannelMode.mockResolvedValue({ mode: 'live', source: 'configured' });
    mockDecideAiDelivery.mockResolvedValue({ action: 'send', mode: 'live', source: 'configured' });
    mockProcessAlexTurn.mockResolvedValue(undefined);
    await start();
    expect(mockProcessAlexTurn).toHaveBeenCalledTimes(1);
    expect(ackCreates()).toHaveLength(0);
  });

  it('if the mode leaves Live while Alex is writing, the reply is deleted before the visitor can ever see it', async () => {
    mockResolveAiChannelMode.mockResolvedValue({ mode: 'live', source: 'configured' });
    mockDecideAiDelivery.mockResolvedValue({ action: 'send', mode: 'live', source: 'configured' });
    mockAssertAiDispatchAllowed.mockRejectedValue(new AiReplySuppressedError());
    let sendError: unknown;
    mockProcessAlexTurn.mockImplementation(async (ctx: any) => {
      try {
        await ctx.send('The Civic is a great pick!');
      } catch (err) {
        sendError = err;
      }
    });
    await start();
    expect(sendError).toBeInstanceOf(AiReplySuppressedError);
    const aiCreate = mockMessageCreate.mock.calls.find(([doc]) => doc?.sentBy?.userId === 'ai-agent');
    expect(aiCreate?.[0].aiDispatchPending).toBe(true);
    expect(mockMessageDeleteOne).toHaveBeenCalledTimes(1);
    expect(mockMessageUpdateOne).not.toHaveBeenCalledWith(expect.anything(), { $set: { aiDispatchPending: false } });
    expect(mockClaimDispatch).not.toHaveBeenCalled();
  });
});

describe('sendWebchatUnavailableAck', () => {
  const session = { _id: 'session-1', organizationId: 'org-1', leadId: 'lead-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageCreate.mockImplementation(async (doc: any) => ({ _id: 'ack-1', createdAt: new Date(), ...doc }));
  });

  it('does not acknowledge once anyone has already replied in the session', async () => {
    mockMessageExists.mockResolvedValue({ _id: 'staff-msg' });
    await expect(sendWebchatUnavailableAck(session)).resolves.toBe(false);
    expect(mockMessageCreate).not.toHaveBeenCalled();
  });

  it('acknowledges at most once per session even with two visitor messages at the same time', async () => {
    mockMessageExists.mockResolvedValue(null);
    mockSessionFindOneAndUpdate.mockResolvedValueOnce({ _id: 'session-1' }).mockResolvedValueOnce(null);
    const results = await Promise.all([sendWebchatUnavailableAck(session), sendWebchatUnavailableAck(session)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mockMessageCreate).toHaveBeenCalledTimes(1);
  });

  it('never throws into the visitor request', async () => {
    mockMessageExists.mockRejectedValue(new Error('db down'));
    await expect(sendWebchatUnavailableAck(session)).resolves.toBe(false);
  });
});
