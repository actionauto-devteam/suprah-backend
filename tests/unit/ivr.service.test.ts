const mockFindOne = jest.fn();
const mockUpdate = jest.fn();
const mockRecipients = jest.fn();
const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
const mockAnswer = jest.fn();
const mockGather = jest.fn();
const mockSpeak = jest.fn();
const mockHangup = jest.fn();
const mockLeadUpdate = jest.fn();

jest.mock('../../src/models/communication.model', () => ({ CallLog: { findOne: mockFindOne, findOneAndUpdate: mockUpdate, find: jest.fn() } }));
jest.mock('../../src/services/callRoutingConfig.service', () => ({ routingGroupRecipients: mockRecipients }));
jest.mock('../../src/services/telnyx.service', () => ({ answerCall: mockAnswer, gatherIvr: mockGather, speakIvr: mockSpeak, hangupCall: mockHangup }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: () => ({ to: mockTo }) }));
jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: { findOneAndUpdate: mockLeadUpdate } }));

import { initializeIvr, handleIvrGather, expireIvr, clearIvrTimer, canReceiveIvrCall } from '../../src/services/ivr.service';

const config = {
  enabled: true, name: 'Test', inboundNumber: '+18015550100', mainNumber: '+18017666137',
  greeting: 'Test menu', ringTimeoutSeconds: 35, retryCount: 1, receptionGroupId: 'reception', allOrgFallback: false,
  options: [
    { digit: '0', label: 'Spanish', type: 'language', groupId: null, leadLocation: '', language: 'Spanish', externalDestination: '' },
    { digit: '1', label: 'Orem', type: 'location', groupId: 'orem', leadLocation: 'Orem', language: '', externalDestination: '' },
    { digit: '2', label: 'Lehi', type: 'location', groupId: 'lehi', leadLocation: 'Lehi', language: '', externalDestination: '' },
    { digit: '3', label: 'Service', type: 'department', groupId: 'service', leadLocation: '', language: '', externalDestination: '+18018752782' },
    { digit: '4', label: 'Title/Licensing', type: 'department', groupId: 'titles', leadLocation: '', language: '', externalDestination: '' },
  ],
} as any;

let stored: any;
const missed = jest.fn();
function setPath(target: any, path: string, value: any) {
  const parts = path.split('.'); const last = parts.pop()!;
  const parent = parts.reduce((row, part) => row[part] ||= {}, target); parent[last] = value;
}
function payload(digits: string, revision = stored.routing.revision) {
  return { call_control_id: 'control', digits, status: 'valid', client_state: Buffer.from(JSON.stringify({ kind: 'ivr-menu', callLogId: 'call', revision })).toString('base64') };
}

beforeEach(() => {
  jest.clearAllMocks();
  stored = { _id: 'call', orgId: 'org', leadId: 'lead', providerCallControlId: 'control', status: 'ivr' };
  mockAnswer.mockResolvedValue({}); mockGather.mockResolvedValue({}); mockSpeak.mockResolvedValue({}); mockHangup.mockResolvedValue({});
  mockRecipients.mockImplementation(async (_org, group) => [`${group}-user`]);
  mockLeadUpdate.mockResolvedValue(null); missed.mockResolvedValue(undefined);
  mockFindOne.mockImplementation(async (filter: any) => {
    if (filter.status && typeof filter.status === 'string' && filter.status !== stored.status) return null;
    if (filter['routing.revision'] !== undefined && filter['routing.revision'] !== stored.routing?.revision) return null;
    if (filter['routing.stage'] && filter['routing.stage'] !== stored.routing?.stage) return null;
    return structuredClone(stored);
  });
  mockUpdate.mockImplementation(async (filter: any, update: any) => {
    if (filter['routing.revision'] !== undefined && filter['routing.revision'] !== stored.routing?.revision) return null;
    if (filter.status && typeof filter.status === 'string' && filter.status !== stored.status) return null;
    for (const [path, value] of Object.entries(update.$set || {})) setPath(stored, path, structuredClone(value));
    for (const [path, value] of Object.entries(update.$inc || {})) {
      const current = path.split('.').reduce((row, part) => row[part], stored); setPath(stored, path, current + Number(value));
    }
    for (const [path, value] of Object.entries(update.$push || {})) path.split('.').reduce((row, part) => row[part], stored).push(value);
    return structuredClone(stored);
  });
});
afterEach(() => clearIvrTimer('call'));

describe('IVR routing with mocked persistence and provider', () => {
  it('answers the customer and gathers without broadcasting a call', async () => {
    await initializeIvr(stored, config, { missed });
    expect(stored.status).toBe('ivr'); expect(stored.routing.stage).toBe('menu');
    expect(mockAnswer).toHaveBeenCalled(); expect(mockGather).toHaveBeenCalledWith('control', 'Test menu', '01234', expect.objectContaining({ kind: 'ivr-menu' }));
    expect(mockEmit).not.toHaveBeenCalled();
  });
  it.each(['0', '1', '2', '3', '4'])('routes digit %s and applies only location metadata', async digit => {
    await initializeIvr(stored, config, { missed });
    await handleIvrGather(payload(digit), { missed });
    const group = ['reception', 'orem', 'lehi', 'service', 'titles'][Number(digit)];
    expect(stored.routing.targetGroupId).toBe(group);
    expect(mockTo).toHaveBeenCalledWith(expect.arrayContaining([`user:${group}-user`]));
    expect(mockTo).not.toHaveBeenCalledWith('org:org');
    expect(mockLeadUpdate).toHaveBeenCalledTimes(['1', '2'].includes(digit) ? 1 : 0);
    if (digit === '0') expect(stored.routing.language).toBe('Spanish');
  });
  it('retries invalid input once then routes to Reception', async () => {
    await initializeIvr(stored, config, { missed });
    await handleIvrGather(payload('9'), { missed });
    expect(mockGather).toHaveBeenCalledTimes(2);
    await handleIvrGather(payload(''), { missed });
    expect(stored.routing.stage).toBe('reception');
  });
  it('falls back from selected group to Reception, then finishes missed once', async () => {
    await initializeIvr(stored, config, { missed }); await handleIvrGather(payload('1'), { missed });
    await expireIvr('call', stored.routing.revision, { missed }); expect(stored.routing.stage).toBe('reception');
    const revision = stored.routing.revision;
    await expireIvr('call', revision, { missed }); await expireIvr('call', revision, { missed });
    expect(stored.status).toBe('missed'); expect(missed).toHaveBeenCalledTimes(1);
  });
  it('uses approved legacy ringing when initialization cannot complete', async () => {
    mockGather.mockRejectedValueOnce(new Error('provider timeout'));
    await initializeIvr(stored, config, { missed });
    expect(stored.status).toBe('ringing'); expect(stored.routing.allOrg).toBe(true);
    expect(mockTo).toHaveBeenCalledWith('org:org');
  });
  it('falls back when the selected group is empty', async () => {
    mockRecipients.mockImplementation(async (_org, group) => group === 'orem' ? [] : ['reception-user']);
    await initializeIvr(stored, config, { missed }); await handleIvrGather(payload('1'), { missed });
    expect(stored.routing.stage).toBe('reception');
  });
  it('ignores duplicate/stale gather results', async () => {
    await initializeIvr(stored, config, { missed }); const event = payload('1');
    await handleIvrGather(event, { missed }); const revision = stored.routing.revision;
    await handleIvrGather(event, { missed });
    expect(stored.routing.revision).toBe(revision); expect(mockLeadUpdate).toHaveBeenCalledTimes(1);
  });
  it('checks live group membership as well as the stored recipient list', async () => {
    await initializeIvr(stored, config, { missed }); await handleIvrGather(payload('1'), { missed });
    expect(await canReceiveIvrCall(stored, 'other-user')).toBe(false);
    mockRecipients.mockResolvedValue([]);
    expect(await canReceiveIvrCall(stored, 'orem-user')).toBe(false);
  });
});
