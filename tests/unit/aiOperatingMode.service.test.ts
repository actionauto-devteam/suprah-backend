const mockOrgFindById = jest.fn();
const mockLeadFindOne = jest.fn();
const mockUsageUpdateOne = jest.fn();
const mockUsageFind = jest.fn();

jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: mockOrgFindById },
}));
jest.mock('../../src/models/AiUsageCounter.model', () => ({
  __esModule: true,
  default: { updateOne: mockUsageUpdateOne, find: mockUsageFind },
}));
jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    __esModule: true,
    default: { ...actual, model: (name: string) => (name === 'Lead' ? { findOne: mockLeadFindOne } : actual.model(name)) },
  };
});
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import {
  modesFromMetadata,
  resolveAiChannelModes,
  decideAiDelivery,
  assertAiDispatchAllowed,
  anyChannelLive,
  recordAiUsage,
  aiUsageDay,
  storedModesFromMetadata,
} from '../../src/services/aiOperatingMode.service';
import { AiReplySuppressedError } from '../../src/utils/aiReplySuppressed';

function orgWith(metadata: any) {
  mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ metadata }) }) });
}

function leadWith(lead: any) {
  mockLeadFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(lead) }) });
}

const DEMO_PHONE = '+18015550142';

describe('AI operating mode resolution', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, AI_AGENT_ENABLED: 'true', DEMO_LAB_ENABLED: 'true' };
  });

  afterAll(() => {
    process.env = env;
  });

  it('turns every channel off when the global kill switch is off, whatever the org says', () => {
    expect(modesFromMetadata({ aiAgentEnabled: true, aiAgentModes: { sms: 'live' } }, false)).toEqual({
      sms: 'off', email: 'off', webchat: 'off', source: 'disabled',
    });
  });

  it('keeps a legacy org that had AI on as live on every channel, so unrelated orgs are not silently switched', () => {
    expect(modesFromMetadata({ aiAgentEnabled: true }, true)).toEqual({
      sms: 'live', email: 'live', webchat: 'live', source: 'legacy',
    });
  });

  it('keeps a legacy org that had AI off as off', () => {
    expect(modesFromMetadata({}, true)).toEqual({ sms: 'off', email: 'off', webchat: 'off', source: 'legacy' });
    expect(modesFromMetadata({ aiAgentEnabled: false }, true).sms).toBe('off');
  });

  it('uses configured per-channel modes and ignores the legacy toggle once configured', () => {
    expect(
      modesFromMetadata({ aiAgentEnabled: true, aiAgentModes: { sms: 'training', email: 'training', webchat: 'off' } }, true),
    ).toEqual({ sms: 'training', email: 'training', webchat: 'off', source: 'configured' });
  });

  it('fails closed on missing or invalid configured values', () => {
    expect(modesFromMetadata({ aiAgentModes: { sms: 'yes', webchat: 'live' } }, true)).toEqual({
      sms: 'off', email: 'off', webchat: 'live', source: 'configured',
    });
  });

  it('reports stored modes without the kill switch so admins see what is saved', () => {
    expect(storedModesFromMetadata({ aiAgentModes: { sms: 'training', email: 'off', webchat: 'live' } })).toEqual({
      sms: 'training', email: 'off', webchat: 'live', source: 'configured',
    });
  });

  it('mirror is true only when some channel is live', () => {
    expect(anyChannelLive({ sms: 'training', email: 'off', webchat: 'training' })).toBe(false);
    expect(anyChannelLive({ sms: 'live', email: 'off', webchat: 'training' })).toBe(true);
  });

  it('fails closed when the organization cannot be read', async () => {
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.reject(new Error('db down')) }) });
    await expect(resolveAiChannelModes('org-1')).resolves.toEqual({
      sms: 'off', email: 'off', webchat: 'off', source: 'disabled',
    });
  });

  it('does not read the organization at all when the kill switch is off', async () => {
    process.env.AI_AGENT_ENABLED = 'false';
    await expect(resolveAiChannelModes('org-1')).resolves.toMatchObject({ sms: 'off', source: 'disabled' });
    expect(mockOrgFindById).not.toHaveBeenCalled();
  });
});

describe('decideAiDelivery', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, AI_AGENT_ENABLED: 'true', DEMO_LAB_ENABLED: 'true' };
  });

  afterAll(() => {
    process.env = env;
  });

  it('sends only when the channel is live', async () => {
    orgWith({ aiAgentModes: { sms: 'live', email: 'training', webchat: 'off' } });
    await expect(decideAiDelivery({ organizationId: 'org-1', channel: 'sms', workflow: 'sms_reply', toPhone: '+13855550199' }))
      .resolves.toMatchObject({ action: 'send', mode: 'live' });
    await expect(decideAiDelivery({ organizationId: 'org-1', channel: 'email', workflow: 'email_reply' }))
      .resolves.toMatchObject({ action: 'skip', mode: 'training' });
    await expect(decideAiDelivery({ organizationId: 'org-1', channel: 'webchat', workflow: 'webchat_reply' }))
      .resolves.toMatchObject({ action: 'skip', mode: 'off' });
  });

  it('skips a real customer in training mode', async () => {
    orgWith({ aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } });
    leadWith({ source: 'Website Chat', phone: '+13855550199' });
    await expect(
      decideAiDelivery({ organizationId: 'org-1', channel: 'sms', workflow: 'sms_reply', toPhone: '+13855550199', leadId: 'lead-1' }),
    ).resolves.toMatchObject({ action: 'skip', mode: 'training' });
  });

  it('allows a simulated send only for a genuine Demo Lab lead with a fictional number while Demo Lab is enabled', async () => {
    orgWith({ aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } });
    leadWith({ source: 'Demo', phone: DEMO_PHONE });
    await expect(
      decideAiDelivery({ organizationId: 'org-1', channel: 'sms', workflow: 'sms_reply', toPhone: DEMO_PHONE, leadId: 'lead-demo' }),
    ).resolves.toMatchObject({ action: 'send', simulated: true });
  });

  it('does not trust a 555 number alone: a real lead with a fictional-looking number is still skipped', async () => {
    orgWith({ aiAgentModes: { sms: 'training' } });
    leadWith({ source: 'Website Inquiry', phone: DEMO_PHONE });
    await expect(
      decideAiDelivery({ organizationId: 'org-1', channel: 'sms', workflow: 'sms_reply', toPhone: DEMO_PHONE, leadId: 'lead-1' }),
    ).resolves.toMatchObject({ action: 'skip' });
  });

  it('skips a demo send when the recipient number does not match the demo lead', async () => {
    orgWith({ aiAgentModes: { sms: 'training' } });
    leadWith({ source: 'Demo', phone: DEMO_PHONE });
    await expect(
      decideAiDelivery({ organizationId: 'org-1', channel: 'sms', workflow: 'sms_reply', toPhone: '+18015550177', leadId: 'lead-demo' }),
    ).resolves.toMatchObject({ action: 'skip' });
  });

  it('skips demo sends when Demo Lab is disabled', async () => {
    process.env.DEMO_LAB_ENABLED = 'false';
    orgWith({ aiAgentModes: { sms: 'training' } });
    leadWith({ source: 'Demo', phone: DEMO_PHONE });
    await expect(
      decideAiDelivery({ organizationId: 'org-1', channel: 'sms', workflow: 'sms_reply', toPhone: DEMO_PHONE, leadId: 'lead-demo' }),
    ).resolves.toMatchObject({ action: 'skip' });
    expect(mockLeadFindOne).not.toHaveBeenCalled();
  });

  it('never simulates email, and never simulates the re-engagement Send anyway action', async () => {
    orgWith({ aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } });
    leadWith({ source: 'Demo', phone: DEMO_PHONE });
    await expect(
      decideAiDelivery({ organizationId: 'org-1', channel: 'email', workflow: 'email_reply', toPhone: DEMO_PHONE, leadId: 'lead-demo' }),
    ).resolves.toMatchObject({ action: 'skip' });
    await expect(
      decideAiDelivery({ organizationId: 'org-1', channel: 'sms', workflow: 'reengagement_send_anyway', toPhone: DEMO_PHONE, leadId: 'lead-demo' }),
    ).resolves.toMatchObject({ action: 'skip' });
  });

  it('skips everything in off mode, including demo leads', async () => {
    orgWith({ aiAgentModes: { sms: 'off' } });
    leadWith({ source: 'Demo', phone: DEMO_PHONE });
    await expect(
      decideAiDelivery({ organizationId: 'org-1', channel: 'sms', workflow: 'sms_reply', toPhone: DEMO_PHONE, leadId: 'lead-demo' }),
    ).resolves.toMatchObject({ action: 'skip', mode: 'off' });
  });

  it('assertAiDispatchAllowed throws the standard suppression error when not allowed', async () => {
    orgWith({ aiAgentModes: { sms: 'training' } });
    await expect(
      assertAiDispatchAllowed({ organizationId: 'org-1', channel: 'sms', workflow: 'sms_followup', toPhone: '+13855550199' }),
    ).rejects.toBeInstanceOf(AiReplySuppressedError);
  });

  it('assertAiDispatchAllowed passes when live', async () => {
    orgWith({ aiAgentModes: { sms: 'live' } });
    await expect(
      assertAiDispatchAllowed({ organizationId: 'org-1', channel: 'sms', workflow: 'sms_followup', toPhone: '+13855550199' }),
    ).resolves.toMatchObject({ action: 'send' });
  });
});

describe('recordAiUsage', () => {
  beforeEach(() => jest.clearAllMocks());

  it('increments a per-org daily counter in Denver time', async () => {
    mockUsageUpdateOne.mockResolvedValue({});
    await recordAiUsage('org-1', 'attention_screen');
    expect(mockUsageUpdateOne).toHaveBeenCalledWith(
      { organizationId: 'org-1', day: aiUsageDay(), kind: 'attention_screen' },
      expect.objectContaining({ $inc: { count: 1 } }),
      { upsert: true },
    );
    expect(aiUsageDay(new Date('2026-10-20T03:30:00Z'))).toBe('2026-10-19');
  });

  it('never throws when the counter cannot be written', async () => {
    mockUsageUpdateOne.mockRejectedValue(new Error('db down'));
    await expect(recordAiUsage('org-1', 'attention_screen')).resolves.toBeUndefined();
  });
});
