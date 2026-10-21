const mockOrgFindById = jest.fn();

jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: mockOrgFindById } }));
jest.mock('../../src/models/AiUsageCounter.model', () => ({ __esModule: true, default: { findOneAndUpdate: jest.fn(), create: jest.fn(), findOne: jest.fn() } }));
jest.mock('../../src/models/AiAgentDraft.model', () => ({ __esModule: true, AI_DRAFT_RETENTION_DAYS: 90, default: { create: jest.fn(), findOne: jest.fn() } }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import {
  eligibilityFromMetadata,
  resolveShadowDraftEligibility,
  resolveOrgTimezone,
  shadowDraftUsageDay,
  canViewShadowDrafts,
  SHADOW_DRAFT_FALLBACK_TIMEZONE,
  SHADOW_DRAFT_DAILY_LIMIT,
  claimShadowDraft,
} from '../../src/services/aiShadowDraft.service';
import AiAgentDraft from '../../src/models/AiAgentDraft.model';

const training = { aiShadowDraftsEnabled: true, aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } };

describe('shadow draft eligibility', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, AI_AGENT_ENABLED: 'true', AI_SHADOW_DRAFTS_ENABLED: 'true' };
  });

  afterAll(() => {
    process.env = env;
  });

  it('is eligible only in Training with both the global and organization flags on', () => {
    expect(eligibilityFromMetadata(training, 'sms')).toMatchObject({ eligible: true, mode: 'training' });
    expect(eligibilityFromMetadata(training, 'email').eligible).toBe(true);
    expect(eligibilityFromMetadata(training, 'webchat').eligible).toBe(true);
  });

  it.each(['off', 'live', 'testing'])('is never eligible in %s mode', (mode) => {
    const metadata = { aiShadowDraftsEnabled: true, aiAgentModes: { sms: mode, email: mode, webchat: mode } };
    for (const channel of ['sms', 'email', 'webchat'] as const) {
      expect(eligibilityFromMetadata(metadata, channel)).toMatchObject({ eligible: false, reason: 'mode_not_training', mode });
    }
  });

  it('checks each channel independently', () => {
    const metadata = { aiShadowDraftsEnabled: true, aiAgentModes: { sms: 'training', email: 'live', webchat: 'off' } };
    expect(eligibilityFromMetadata(metadata, 'sms').eligible).toBe(true);
    expect(eligibilityFromMetadata(metadata, 'email').eligible).toBe(false);
    expect(eligibilityFromMetadata(metadata, 'webchat').eligible).toBe(false);
  });

  it('is never eligible for a legacy organization that has not configured modes', () => {
    expect(eligibilityFromMetadata({ aiShadowDraftsEnabled: true, aiAgentEnabled: true }, 'sms')).toMatchObject({ eligible: false, reason: 'mode_not_training', source: 'legacy' });
  });

  it('is off by default: no global flag means no drafts even with the organization flag on', () => {
    delete process.env.AI_SHADOW_DRAFTS_ENABLED;
    expect(eligibilityFromMetadata(training, 'sms')).toMatchObject({ eligible: false, reason: 'global_flag_off' });
    process.env.AI_SHADOW_DRAFTS_ENABLED = 'false';
    expect(eligibilityFromMetadata(training, 'sms')).toMatchObject({ eligible: false, reason: 'global_flag_off' });
  });

  it('is off by default at the organization level', () => {
    const { aiShadowDraftsEnabled, ...withoutFlag } = training;
    expect(aiShadowDraftsEnabled).toBe(true);
    expect(eligibilityFromMetadata(withoutFlag, 'sms')).toMatchObject({ eligible: false, reason: 'org_flag_off' });
    expect(eligibilityFromMetadata({ ...training, aiShadowDraftsEnabled: 'true' }, 'sms')).toMatchObject({ eligible: false, reason: 'org_flag_off' });
  });

  it('the global AI master switch turns shadow drafts off too', () => {
    process.env.AI_AGENT_ENABLED = 'false';
    expect(eligibilityFromMetadata(training, 'sms')).toMatchObject({ eligible: false, reason: 'ai_master_off' });
  });

  it('does not read the organization at all when the global flag or master switch is off', async () => {
    delete process.env.AI_SHADOW_DRAFTS_ENABLED;
    await resolveShadowDraftEligibility('org-1', 'sms');
    process.env.AI_SHADOW_DRAFTS_ENABLED = 'true';
    process.env.AI_AGENT_ENABLED = 'false';
    await resolveShadowDraftEligibility('org-1', 'sms');
    expect(mockOrgFindById).not.toHaveBeenCalled();
  });

  it('fails closed when the organization cannot be read or does not exist', async () => {
    mockOrgFindById.mockReturnValueOnce({ select: () => ({ lean: () => Promise.reject(new Error('db down')) }) });
    await expect(resolveShadowDraftEligibility('org-1', 'sms')).resolves.toMatchObject({ eligible: false, reason: 'org_not_found' });
    mockOrgFindById.mockReturnValueOnce({ select: () => ({ lean: () => Promise.resolve(null) }) });
    await expect(resolveShadowDraftEligibility('org-1', 'sms')).resolves.toMatchObject({ eligible: false, reason: 'org_not_found' });
  });

  it('an ineligible claim never writes a draft row', async () => {
    mockOrgFindById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ metadata: { ...training, aiShadowDraftsEnabled: false } }) }) });
    await expect(claimShadowDraft({ organizationId: 'org-1', channel: 'sms', sourceMessageId: 'm1', sourceMessageModel: 'CommunicationMessage' }))
      .resolves.toEqual({ outcome: 'ineligible', reason: 'org_flag_off' });
    expect((AiAgentDraft as any).create).not.toHaveBeenCalled();
  });
});

describe('shadow draft day boundary and limits', () => {
  it('uses the organization timezone when valid, and America/Denver otherwise', () => {
    expect(SHADOW_DRAFT_FALLBACK_TIMEZONE).toBe('America/Denver');
    expect(resolveOrgTimezone({ timezone: 'Asia/Manila' })).toBe('Asia/Manila');
    expect(resolveOrgTimezone({ timezone: 'Not/AZone' })).toBe('America/Denver');
    expect(resolveOrgTimezone({})).toBe('America/Denver');
    expect(resolveOrgTimezone(undefined)).toBe('America/Denver');
  });

  it('rolls the day over at local midnight, not UTC midnight', () => {
    const lateDenverEvening = new Date('2026-10-20T05:30:00Z');
    expect(shadowDraftUsageDay('America/Denver', lateDenverEvening)).toBe('2026-10-19');
    expect(shadowDraftUsageDay('Asia/Manila', lateDenverEvening)).toBe('2026-10-20');
  });

  it('the daily limit is 100 attempts', () => {
    expect(SHADOW_DRAFT_DAILY_LIMIT).toBe(100);
  });
});

describe('shadow draft viewing roles', () => {
  it('lets managers and admins view drafts, but not employees', () => {
    expect(canViewShadowDrafts('admin')).toBe(true);
    expect(canViewShadowDrafts('manager')).toBe(true);
    expect(canViewShadowDrafts('super_admin')).toBe(true);
    expect(canViewShadowDrafts('employee')).toBe(false);
    expect(canViewShadowDrafts(undefined)).toBe(false);
  });
});
