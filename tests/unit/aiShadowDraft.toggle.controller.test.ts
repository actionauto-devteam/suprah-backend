const mockOrgFindById = jest.fn();
const mockOrgUpdateOne = jest.fn();
const mockLogCreate = jest.fn();
const mockLogFind = jest.fn();
const mockEmitToOrg = jest.fn();
const mockUsageFind = jest.fn();
const mockUsageFindOne = jest.fn();

jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: mockOrgFindById, updateOne: mockOrgUpdateOne } }));
jest.mock('../../src/models/AiModeChangeLog.model', () => ({ __esModule: true, default: { create: mockLogCreate, find: mockLogFind, insertMany: jest.fn() } }));
jest.mock('../../src/models/AiUsageCounter.model', () => ({ __esModule: true, default: { find: mockUsageFind, findOne: mockUsageFindOne, updateOne: jest.fn() } }));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToOrg: mockEmitToOrg }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { getAiModes, updateShadowDrafts } from '../../src/controllers/aiOperatingMode.controller';

let storedMetadata: any = {};

function chain(value: any) {
  return { select: () => ({ lean: () => Promise.resolve(value) }), sort: () => ({ limit: () => ({ lean: () => Promise.resolve(value) }) }) };
}

async function invoke(fn: any, req: any) {
  const json = jest.fn();
  const next = jest.fn();
  fn(req, { json, status: jest.fn(() => ({ json })) } as any, next);
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  return { json, next };
}

const admin = { _id: 'user-1', role: 'admin', fullName: 'Jen Admin' };

describe('shadow drafts organization toggle', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, AI_AGENT_ENABLED: 'true', AI_SHADOW_DRAFTS_ENABLED: 'true' };
    storedMetadata = { aiAgentName: 'Anna', aiAgentModes: { sms: 'training', email: 'live', webchat: 'off' } };
    mockOrgFindById.mockImplementation(() => ({ select: () => ({ lean: () => Promise.resolve({ metadata: storedMetadata }) }) }));
    mockOrgUpdateOne.mockImplementation(async (_f: any, update: any) => {
      for (const [k, v] of Object.entries(update.$set || {})) storedMetadata[k.replace('metadata.', '')] = v;
      return {};
    });
    mockLogFind.mockImplementation((filter: any) => chain(filter.channel === 'shadow_drafts'
      ? [{ _id: 's1', channel: 'shadow_drafts', fromMode: 'off', toMode: 'on', changedByName: 'Jen Admin', createdAt: new Date() }]
      : [{ _id: 'm1', channel: 'sms', fromMode: 'live', toMode: 'training', changedByName: 'Jen Admin', createdAt: new Date() }]));
    mockUsageFind.mockReturnValue(chain([]));
    mockUsageFindOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ count: 7 }) }) });
    mockLogCreate.mockResolvedValue({});
  });

  afterAll(() => {
    process.env = env;
  });

  it('is off by default and reports which channels would produce drafts once enabled', async () => {
    const { json } = await invoke(getAiModes, { orgId: 'org-1', crmUser: admin });
    const shadow = json.mock.calls[0][0].data.shadowDrafts;
    expect(shadow).toMatchObject({ globalEnabled: true, orgEnabled: false, activeChannels: [], usedToday: 7, dailyLimit: 100, timezone: 'America/Denver' });
  });

  it('only admins can change it', async () => {
    for (const role of ['manager', 'employee']) {
      const { next } = await invoke(updateShadowDrafts, { orgId: 'org-1', crmUser: { _id: 'u', role }, body: { enabled: true } });
      expect(next.mock.calls[0][0].statusCode).toBe(403);
    }
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockLogCreate).not.toHaveBeenCalled();
  });

  it('requires a real boolean', async () => {
    const { next } = await invoke(updateShadowDrafts, { orgId: 'org-1', crmUser: admin, body: { enabled: 'yes' } });
    expect(next.mock.calls[0][0].statusCode).toBe(400);
  });

  it('turning it on saves the setting, writes an audit row, and only Training channels become active', async () => {
    const { json, next } = await invoke(updateShadowDrafts, { orgId: 'org-1', crmUser: admin, body: { enabled: true, reason: 'Start shadow training' } });
    expect(next).not.toHaveBeenCalled();
    expect(storedMetadata.aiShadowDraftsEnabled).toBe(true);
    expect(mockLogCreate).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1', channel: 'shadow_drafts', fromMode: 'off', toMode: 'on', reason: 'Start shadow training', changedByName: 'Jen Admin',
    }));
    expect(json.mock.calls[0][0].data.shadowDrafts.activeChannels).toEqual(['sms']);
    expect(mockEmitToOrg).toHaveBeenCalledWith('org-1', 'ai:modes_updated', { shadowDraftsEnabled: true });
  });

  it('saving the same value writes no audit row', async () => {
    storedMetadata.aiShadowDraftsEnabled = true;
    await invoke(updateShadowDrafts, { orgId: 'org-1', crmUser: admin, body: { enabled: true } });
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockLogCreate).not.toHaveBeenCalled();
  });

  it('keeps shadow toggles out of the channel mode history list', async () => {
    const { json } = await invoke(getAiModes, { orgId: 'org-1', crmUser: admin });
    const data = json.mock.calls[0][0].data;
    expect(mockLogFind).toHaveBeenCalledWith({ organizationId: 'org-1', channel: { $in: ['sms', 'email', 'webchat'] } });
    expect(data.recentChanges.every((row: any) => row.channel !== 'shadow_drafts')).toBe(true);
    expect(data.shadowDrafts.recentChanges).toHaveLength(1);
  });

  it('the global flag off keeps every channel inactive even when the organization turns it on', async () => {
    delete process.env.AI_SHADOW_DRAFTS_ENABLED;
    storedMetadata.aiShadowDraftsEnabled = true;
    const { json } = await invoke(getAiModes, { orgId: 'org-1', crmUser: admin });
    expect(json.mock.calls[0][0].data.shadowDrafts).toMatchObject({ globalEnabled: false, orgEnabled: true, activeChannels: [] });
  });
});
