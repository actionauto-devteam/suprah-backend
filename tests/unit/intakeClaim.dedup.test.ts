const mockLeadCreate = jest.fn();
const mockUserFindOne = jest.fn();
const mockVehicleFindById = jest.fn();
const mockOrgFindOne = jest.fn();
const mockOrgFindById = jest.fn();
const mockSessionCreate = jest.fn();
const mockSessionFindOne = jest.fn();
const mockMessageCreate = jest.fn();
const mockMessageFind = jest.fn();
const mockIntakeClaimFindOneAndUpdate = jest.fn();
const mockIntakeClaimUpdateOne = jest.fn();
const mockEmitToOrg = jest.fn();
const mockNotifyOrgAdmins = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { create: mockLeadCreate },
}));
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findOne: mockUserFindOne },
}));
jest.mock('../../src/models/Vehicle.model', () => ({
  __esModule: true,
  default: { findById: mockVehicleFindById },
}));
jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findOne: mockOrgFindOne, findById: mockOrgFindById },
}));
jest.mock('../../src/models/WebChatSession.model', () => ({
  __esModule: true,
  default: { create: mockSessionCreate, findOne: mockSessionFindOne },
}));
jest.mock('../../src/models/WebChatMessage.model', () => ({
  __esModule: true,
  default: { create: mockMessageCreate, find: mockMessageFind },
}));
jest.mock('../../src/models/IntakeClaim.model', () => ({
  __esModule: true,
  default: { findOneAndUpdate: mockIntakeClaimFindOneAndUpdate, updateOne: mockIntakeClaimUpdateOne },
}));
jest.mock('../../src/utils/socketEmitter', () => ({
  __esModule: true,
  emitToOrg: mockEmitToOrg,
}));
jest.mock('../../src/utils/safeNotification', () => ({
  __esModule: true,
  notifyOrgAdmins: mockNotifyOrgAdmins,
}));
jest.mock('../../src/utils/notificationTemplates', () => ({
  __esModule: true,
  notificationTemplates: { new_lead: jest.fn().mockReturnValue({ title: 't', message: 'm' }) },
}));
jest.mock('../../src/utils/aiAgentTask', () => ({ __esModule: true, createAiAgentTaskAndNotify: jest.fn() }));
jest.mock('../../src/utils/leadNote', () => ({ __esModule: true, addLeadNoteAndNotify: jest.fn() }));
jest.mock('../../src/utils/aiAutoPause', () => ({ __esModule: true, recordHumanTakeover: jest.fn() }));
jest.mock('../../src/utils/sendingWindow', () => ({ __esModule: true, isWithinSendingHours: jest.fn().mockReturnValue(true) }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../src/services/aiAgent.service', () => ({
  __esModule: true,
  resolveAiAgentSettings: jest.fn().mockResolvedValue({ enabled: false, agentName: 'Alex' }),
  processAlexTurn: jest.fn(),
  HISTORY_LIMIT: 12,
}));
jest.mock('../../src/services/aiHumanAttention.service', () => ({
  beginAiAttentionCheck: jest.fn().mockImplementation(async input => input),
  finishAiAttentionCheck: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import { startSession } from '../../src/controllers/webchat.controller';

async function invoke(fn: any, body: any) {
  const req: any = { body, params: {} };
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: any = { status, json };
  const next = jest.fn();
  fn(req, res, next);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return { res, next, json, status };
}

describe('Webchat public-booking double-submit fix (IntakeClaim dedup)', () => {
  const orgId = new mongoose.Types.ObjectId();
  const leadId = new mongoose.Types.ObjectId();

  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgFindOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: orgId }) }) });
    mockOrgFindById.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ metadata: { webchatEnabled: true } }) }) });
    mockUserFindOne.mockReturnValue({
      sort: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'staff-1' }) }) }),
    });
    mockLeadCreate.mockResolvedValue({ _id: leadId, toObject: () => ({ _id: leadId }) });
    mockSessionCreate.mockResolvedValue({ _id: 'session-new', save: jest.fn() });
    mockMessageCreate.mockResolvedValue({ _id: 'msg-1', direction: 'inbound', body: 'hi', createdAt: new Date() });
  });

  function callStart(body: any) {
    return invoke(startSession, {
      orgKey: 'test-org',
      name: 'Jordan Lee',
      phone: '8015550100',
      message: 'Hi there',
      ...body,
    });
  }

  it('proceeds normally (creates exactly one Lead) when no clientRequestId is sent', async () => {
    await callStart({});
    expect(mockIntakeClaimFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockLeadCreate).toHaveBeenCalledTimes(1);
  });

  it('creates the claim and the Lead on a first submission with a clientRequestId', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: {} });
    mockIntakeClaimUpdateOne.mockResolvedValue({});

    await callStart({ clientRequestId: 'req-abc' });

    expect(mockLeadCreate).toHaveBeenCalledTimes(1);
    expect(mockIntakeClaimUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ claimKey: 'req-abc' }),
      expect.objectContaining({ $set: { leadId } }),
    );
  });

  it('replays the existing session instead of creating a second Lead when the same clientRequestId is resubmitted after success', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: true },
      value: { leadId },
    });
    const savedSession = { _id: 'session-existing', tokenHash: 'old-hash', save: jest.fn().mockResolvedValue(undefined) };
    mockSessionFindOne.mockReturnValue({ sort: jest.fn().mockResolvedValue(savedSession) });
    mockMessageFind.mockReturnValue({ sort: jest.fn().mockResolvedValue([]) });

    const { status } = await callStart({ clientRequestId: 'req-abc' });

    expect(mockLeadCreate).not.toHaveBeenCalled();
    expect(savedSession.save).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(201);
  });

  it('returns 409 when the same clientRequestId is resubmitted while the original request is still in flight', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: true },
      value: { leadId: null },
    });

    const { next } = await callStart({ clientRequestId: 'req-abc' });

    expect(mockLeadCreate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 409 }));
  });

  it('calls IntakeClaim.findOneAndUpdate exactly once per request regardless of a concurrent duplicate (claim is attempted, not double-created)', async () => {
    mockIntakeClaimFindOneAndUpdate.mockResolvedValueOnce({ lastErrorObject: { updatedExisting: false }, value: {} });
    mockIntakeClaimUpdateOne.mockResolvedValue({});

    await callStart({ clientRequestId: 'req-race' });

    expect(mockIntakeClaimFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });
});
