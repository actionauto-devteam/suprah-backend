const mockOrgFindById = jest.fn();
const mockOrgUpdateOne = jest.fn();
const mockLogInsertMany = jest.fn();
const mockLogFind = jest.fn();
const mockEmitToOrg = jest.fn();
const mockUsageFind = jest.fn();

jest.mock('../../src/models/Organization.model', () => ({
  __esModule: true,
  default: { findById: mockOrgFindById, updateOne: mockOrgUpdateOne },
}));
jest.mock('../../src/models/AiModeChangeLog.model', () => ({
  __esModule: true,
  default: { insertMany: mockLogInsertMany, find: mockLogFind },
}));
jest.mock('../../src/models/AiUsageCounter.model', () => ({
  __esModule: true,
  default: { find: mockUsageFind, updateOne: jest.fn() },
}));
jest.mock('../../src/utils/socketEmitter', () => ({ emitToOrg: mockEmitToOrg }));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { getAiModes, updateAiModes, LIVE_CONFIRMATION_PHRASE } from '../../src/controllers/aiOperatingMode.controller';

let storedMetadata: any = {};

function listChain(value: any) {
  return {
    select: () => ({ lean: () => Promise.resolve(value) }),
    sort: () => ({ limit: () => ({ lean: () => Promise.resolve(value) }) }),
  };
}

async function invoke(fn: any, req: any) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const res: any = { json, status };
  const next = jest.fn();
  fn(req, res, next);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  return { json, next };
}

const admin = { _id: 'user-1', role: 'admin', fullName: 'Jen Admin' };

describe('AI operating mode admin endpoint', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env, AI_AGENT_ENABLED: 'true' };
    storedMetadata = {};
    mockOrgFindById.mockImplementation(() => ({
      select: () => {
        const doc = { metadata: storedMetadata };
        const promise: any = Promise.resolve(doc);
        promise.lean = () => Promise.resolve(doc);
        return promise;
      },
    }));
    mockOrgUpdateOne.mockImplementation(async (_filter: any, update: any) => {
      const set = update.$set || {};
      for (const [key, value] of Object.entries(set)) storedMetadata[key.replace('metadata.', '')] = value;
      return {};
    });
    mockLogFind.mockReturnValue(listChain([]));
    mockUsageFind.mockReturnValue(listChain([{ kind: 'attention_screen', count: 4 }]));
    mockLogInsertMany.mockResolvedValue([]);
  });

  afterAll(() => {
    process.env = env;
  });

  it('shows a legacy org as legacy with its existing behavior preserved', async () => {
    storedMetadata = { aiAgentEnabled: true };
    const { json } = await invoke(getAiModes, { orgId: 'org-1', crmUser: { _id: 'u2', role: 'employee' } });
    const data = json.mock.calls[0][0].data;
    expect(data.source).toBe('legacy');
    expect(data.modes).toEqual({ sms: 'live', email: 'live', webchat: 'live' });
    expect(data.canEdit).toBe(false);
    expect(data.usageToday.attention_screen).toBe(4);
  });

  it('only admins can change modes', async () => {
    const { next } = await invoke(updateAiModes, { orgId: 'org-1', crmUser: { _id: 'u2', role: 'manager' }, body: { modes: { sms: 'training' } } });
    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });

  it('rejects unknown modes', async () => {
    const { next } = await invoke(updateAiModes, { orgId: 'org-1', crmUser: admin, body: { modes: { sms: 'auto' } } });
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });

  it('moves a legacy live org to training on every channel, mirrors the old toggle off, and audits each channel', async () => {
    storedMetadata = { aiAgentEnabled: true };
    const { json, next } = await invoke(updateAiModes, {
      orgId: 'org-1',
      crmUser: admin,
      body: { modes: { sms: 'training', email: 'training', webchat: 'training' } },
    });
    expect(next).not.toHaveBeenCalled();
    expect(storedMetadata.aiAgentModes).toEqual({ sms: 'training', email: 'training', webchat: 'training' });
    expect(storedMetadata.aiAgentEnabled).toBe(false);
    const rows = mockLogInsertMany.mock.calls[0][0];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ channel: 'sms', fromMode: 'live', toMode: 'training', fromSource: 'legacy', changedByName: 'Jen Admin' });
    expect(mockEmitToOrg).toHaveBeenCalledWith('org-1', 'ai:modes_updated', expect.anything());
    expect(json.mock.calls[0][0].data.source).toBe('configured');
  });

  it('refuses to go live without the typed confirmation', async () => {
    storedMetadata = { aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } };
    const { next } = await invoke(updateAiModes, {
      orgId: 'org-1', crmUser: admin, body: { modes: { webchat: 'live' }, reason: 'Ms. Jen approved' },
    });
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockLogInsertMany).not.toHaveBeenCalled();
  });

  it('refuses to go live without a reason', async () => {
    storedMetadata = { aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } };
    const { next } = await invoke(updateAiModes, {
      orgId: 'org-1', crmUser: admin, body: { modes: { webchat: 'live' }, confirmLive: LIVE_CONFIRMATION_PHRASE },
    });
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });

  it('a legacy live org saving Live still needs confirmation, because it becomes an explicit audited Live', async () => {
    storedMetadata = { aiAgentEnabled: true };
    const { next } = await invoke(updateAiModes, {
      orgId: 'org-1', crmUser: admin, body: { modes: { sms: 'live', email: 'training', webchat: 'training' } },
    });
    expect(next.mock.calls[0][0].statusCode).toBe(400);
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
  });

  it('goes live for one channel with confirmation and reason, audits only that channel, and mirrors the toggle on', async () => {
    storedMetadata = { aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } };
    const { next } = await invoke(updateAiModes, {
      orgId: 'org-1',
      crmUser: admin,
      body: { modes: { webchat: 'live' }, confirmLive: LIVE_CONFIRMATION_PHRASE, reason: 'Ms. Jen approved web chat' },
    });
    expect(next).not.toHaveBeenCalled();
    expect(storedMetadata.aiAgentModes).toEqual({ sms: 'training', email: 'training', webchat: 'live' });
    expect(storedMetadata.aiAgentEnabled).toBe(true);
    const rows = mockLogInsertMany.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'webchat', fromMode: 'training', toMode: 'live', reason: 'Ms. Jen approved web chat' });
  });

  it('switching a live channel back to training needs no confirmation and turns the mirror off', async () => {
    storedMetadata = { aiAgentModes: { sms: 'live', email: 'training', webchat: 'training' }, aiAgentEnabled: true };
    const { next } = await invoke(updateAiModes, { orgId: 'org-1', crmUser: admin, body: { modes: { sms: 'training' } } });
    expect(next).not.toHaveBeenCalled();
    expect(storedMetadata.aiAgentModes.sms).toBe('training');
    expect(storedMetadata.aiAgentEnabled).toBe(false);
  });

  it('does nothing and writes no audit row when nothing changed', async () => {
    storedMetadata = { aiAgentModes: { sms: 'training', email: 'training', webchat: 'off' } };
    await invoke(updateAiModes, { orgId: 'org-1', crmUser: admin, body: { modes: { sms: 'training' } } });
    expect(mockOrgUpdateOne).not.toHaveBeenCalled();
    expect(mockLogInsertMany).not.toHaveBeenCalled();
  });
});
