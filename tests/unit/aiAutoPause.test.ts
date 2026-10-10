const mockConvUpdate = jest.fn();
const mockSessionUpdate = jest.fn();
const mockResolveSettings = jest.fn();
const mockEmit = jest.fn();

jest.mock('../../src/models/communication.model', () => ({
  __esModule: true,
  Conversation: { updateOne: mockConvUpdate },
}));

jest.mock('../../src/models/WebChatSession.model', () => ({
  __esModule: true,
  default: { updateOne: mockSessionUpdate },
}));

jest.mock('../../src/services/aiAgent.service', () => ({
  __esModule: true,
  resolveAiAgentSettings: mockResolveSettings,
}));

jest.mock('../../src/utils/socketEmitter', () => ({
  __esModule: true,
  emitToOrg: mockEmit,
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { recordHumanTakeover, AI_AGENT_AUTO_PAUSE_MS } from '../../src/utils/aiAutoPause';

describe('recordHumanTakeover', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveSettings.mockResolvedValue({ enabled: true, agentName: 'Alex' });
    mockConvUpdate.mockResolvedValue({ modifiedCount: 1 });
    mockSessionUpdate.mockResolvedValue({ modifiedCount: 1 });
  });

  it('sets aiAutoPausedUntil roughly AI_AGENT_AUTO_PAUSE_MS ahead for an SMS conversation when Alex is enabled', async () => {
    const before = Date.now();
    await recordHumanTakeover({ kind: 'sms', organizationId: 'org-1', conversationId: 'conv-1', leadId: 'lead-1' });

    expect(mockConvUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = mockConvUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'conv-1', aiPausedAt: null });
    const until = update.$set.aiAutoPausedUntil as Date;
    expect(until.getTime()).toBeGreaterThanOrEqual(before + AI_AGENT_AUTO_PAUSE_MS - 1000);
    expect(until.getTime()).toBeLessThanOrEqual(Date.now() + AI_AGENT_AUTO_PAUSE_MS + 1000);
  });

  it('no-ops (no writes) when Alex is disabled for the org', async () => {
    mockResolveSettings.mockResolvedValueOnce({ enabled: false, agentName: 'Alex' });
    await recordHumanTakeover({ kind: 'sms', organizationId: 'org-1', conversationId: 'conv-1' });

    expect(mockConvUpdate).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });

  it('scopes the SMS write so it can never clobber an active manual pause', async () => {
    await recordHumanTakeover({ kind: 'sms', organizationId: 'org-1', conversationId: 'conv-1' });
    const [filter] = mockConvUpdate.mock.calls[0];
    expect(filter.aiPausedAt).toBe(null);
  });

  it('sets aiAutoPausedUntil for a webchat session when Alex is enabled', async () => {
    await recordHumanTakeover({ kind: 'webchat', organizationId: 'org-1', sessionId: 'sess-1', leadId: 'lead-1' });

    expect(mockSessionUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = mockSessionUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: 'sess-1', aiPausedAt: { $exists: false } });
    expect(update.$set.aiAutoPausedUntil).toBeInstanceOf(Date);
  });

  it('scopes the webchat write so it can never clobber an active manual pause', async () => {
    await recordHumanTakeover({ kind: 'webchat', organizationId: 'org-1', sessionId: 'sess-1' });
    const [filter] = mockSessionUpdate.mock.calls[0];
    expect(filter.aiPausedAt).toEqual({ $exists: false });
  });

  it('never throws even if the DB write rejects', async () => {
    mockConvUpdate.mockRejectedValueOnce(new Error('db down'));
    await expect(
      recordHumanTakeover({ kind: 'sms', organizationId: 'org-1', conversationId: 'conv-1' }),
    ).resolves.toBeUndefined();
  });

  it('emits comm:ai_paused with paused:false and an ISO autoPausedUntil only when the write actually matched', async () => {
    await recordHumanTakeover({ kind: 'sms', organizationId: 'org-1', conversationId: 'conv-1', leadId: 'lead-1' });
    expect(mockEmit).toHaveBeenCalledWith(
      'org-1',
      'comm:ai_paused',
      expect.objectContaining({ conversationId: 'conv-1', leadId: 'lead-1', paused: false }),
    );
    const payload = mockEmit.mock.calls[0][2];
    expect(typeof payload.autoPausedUntil).toBe('string');
    expect(new Date(payload.autoPausedUntil).toString()).not.toBe('Invalid Date');
  });

  it('does not emit when the write matched nothing (e.g. already manually paused)', async () => {
    mockConvUpdate.mockResolvedValueOnce({ modifiedCount: 0 });
    await recordHumanTakeover({ kind: 'sms', organizationId: 'org-1', conversationId: 'conv-1' });
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('emits webchat:ai_paused for the webchat kind', async () => {
    await recordHumanTakeover({ kind: 'webchat', organizationId: 'org-1', sessionId: 'sess-1', leadId: 'lead-1' });
    expect(mockEmit).toHaveBeenCalledWith(
      'org-1',
      'webchat:ai_paused',
      expect.objectContaining({ leadId: 'lead-1', paused: false }),
    );
  });

  it('no-ops when the required id for the given kind is missing', async () => {
    await recordHumanTakeover({ kind: 'sms', organizationId: 'org-1' });
    await recordHumanTakeover({ kind: 'webchat', organizationId: 'org-1' });
    expect(mockConvUpdate).not.toHaveBeenCalled();
    expect(mockSessionUpdate).not.toHaveBeenCalled();
  });
});
