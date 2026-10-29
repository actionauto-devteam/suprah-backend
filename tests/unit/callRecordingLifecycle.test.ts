const mockCallId = jest.fn(); const mockCallFind = jest.fn(); const mockCallUpdate = jest.fn();
const mockSettings = jest.fn(); const mockRecordFind = jest.fn(); const mockRecordId = jest.fn(); const mockRecordUpdate = jest.fn(); const mockReserve = jest.fn(); const mockCreate = jest.fn(); const mockRemove = jest.fn();
jest.mock('../../src/models/communication.model', () => ({ CallLog: { findById: mockCallId, findOne: mockCallFind, updateOne: mockCallUpdate } }));
jest.mock('../../src/models/CallRecording.model', () => ({ DEFAULT_RECORDING_ANNOUNCEMENT: 'This call is now being recorded.', CallRecording: { findOne: mockRecordFind, findById: mockRecordId, findOneAndUpdate: mockReserve, updateOne: mockRecordUpdate, create: mockCreate, deleteOne: mockRemove }, CallRecordingSettings: { findOne: mockSettings } }));
jest.mock('../../src/services/callRecordingStorage.service', () => ({}));
jest.mock('../../src/services/callRecordingAccess.service', () => ({ recordingAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/telnyx.service', () => ({ recordingCommand: jest.fn().mockResolvedValue({}), recordingDisclosure: jest.fn().mockResolvedValue({}) }));
import { startManualRecording, controlRecording, observeRecordingCall, finishRecordingDisclosure } from '../../src/services/callRecording.service';
import * as telnyx from '../../src/services/telnyx.service';
let call: any; let settings: any; let record: any;
const principal: any = { id: 'rep', orgId: 'org', kind: 'crm' };
const encode = (data: any) => Buffer.from(JSON.stringify(data)).toString('base64');
function apply(target: any, update: any) {
  for (const [key, value] of Object.entries(update.$set || {})) { const parts = key.split('.'); const last = parts.pop()!; const parent = parts.reduce((row, part) => row[part] ||= {}, target); parent[last] = value; }
  for (const [key, value] of Object.entries(update.$inc || {})) target[key] = (target[key] || 0) + Number(value);
}
async function announce() {
  await startManualRecording(principal, call._id);
  await finishRecordingDisclosure({ call_control_id: 'customer', client_state: encode({ recordingDisclosureId: record._id }), status: 'completed' });
}
beforeEach(() => {
  jest.clearAllMocks();
  call = { _id: '507f1f77bcf86cd799439021', orgId: 'org', direction: 'inbound', from: '+18015550100', to: '+18015550999', status: 'in-progress', answeredBy: { userId: 'rep' }, providerCallControlId: 'customer', providerCallSessionId: 'session', agentLegCallControlId: 'agent', recordingCorrelation: { verified: true, answerControlId: 'agent', connectionId: 'connection', bridged: true, customerLegId: 'customer-leg' } };
  settings = null;
  record = null;
  mockCallId.mockImplementation(() => ({ select: async () => structuredClone(call) }));
  mockCallFind.mockImplementation(() => ({ select: async () => structuredClone(call), then: (resolve: any) => resolve(structuredClone(call)) }));
  mockSettings.mockImplementation(() => ({ lean: async () => structuredClone(settings) }));
  mockCreate.mockImplementation(async (doc: any) => { record = { _id: '507f1f77bcf86cd799439031', revision: 0, files: [], manualPaused: false, ...structuredClone(doc) }; return structuredClone(record); });
  mockRemove.mockImplementation(async () => { record = null; return {}; });
  mockRecordId.mockImplementation(async () => structuredClone(record)); mockRecordFind.mockImplementation(async (query: any) => !record || (query.state && query.state !== record.state) ? null : structuredClone(record));
  mockReserve.mockImplementation(async (query: any, update: any) => { if (!record || (query.revision !== undefined && (query.revision !== record.revision || query.state !== record.state))) return null; apply(record, update); return structuredClone(record); });
  mockRecordUpdate.mockImplementation(async (query: any, update: any) => { if (record && (query.revision === undefined || query.revision === record.revision)) apply(record, update); return {}; });
  mockCallUpdate.mockImplementation(async (_query: any, update: any) => { apply(call, update); return {}; });
  (telnyx.recordingCommand as jest.Mock).mockResolvedValue({}); (telnyx.recordingDisclosure as jest.Mock).mockResolvedValue({});
});
describe('Mocked manual recording lifecycle', () => {
  it('the rep on the call starts it: the announcement plays on the customer leg first, then recording starts once', async () => {
    await startManualRecording(principal, call._id);
    expect(record.state).toBe('disclosing'); expect(record.employeeId).toBe('rep'); expect(record.policy).toMatchObject({ connectionId: 'connection', retentionMonths: 6, disclosureText: 'This call is now being recorded.' });
    expect(telnyx.recordingDisclosure).toHaveBeenCalledWith('customer', 'This call is now being recorded.', 'en-US', expect.any(String), expect.any(String));
    expect(telnyx.recordingCommand).not.toHaveBeenCalled();
    const done = { call_control_id: 'customer', client_state: encode({ recordingDisclosureId: record._id }), status: 'completed' };
    await finishRecordingDisclosure(done); await finishRecordingDisclosure(done);
    expect(telnyx.recordingCommand).toHaveBeenCalledTimes(1); expect(telnyx.recordingCommand).toHaveBeenCalledWith('customer', 'start', expect.any(String)); expect(record.state).toBe('recording');
  });
  it('uses the dealership announcement and retention when they are set', async () => {
    settings = { announcementText: 'Recorded for training.', announcementLanguage: 'en-US', retentionMonths: 12 };
    await startManualRecording(principal, call._id);
    expect(record.policy).toMatchObject({ disclosureText: 'Recorded for training.', retentionMonths: 12 });
  });
  it('someone who is not on the call cannot start it', async () => {
    await expect(startManualRecording({ ...principal, id: 'other' }, call._id)).rejects.toThrow('Only the rep');
    expect(mockCreate).not.toHaveBeenCalled(); expect(telnyx.recordingDisclosure).not.toHaveBeenCalled();
  });
  it.each([['still connecting', () => { call.recordingCorrelation.bridged = false; }], ['answered on the employee phone', () => { call.answeredVia = 'phone'; }], ['ended', () => { call.status = 'completed'; }]])('a call that is %s cannot be recorded', async (_label, change) => {
    change(); await expect(startManualRecording(principal, call._id)).rejects.toThrow('still connecting'); expect(mockCreate).not.toHaveBeenCalled();
  });
  it('a second Record press is refused while the first recording exists', async () => {
    await announce(); await expect(startManualRecording(principal, call._id)).rejects.toThrow('already being recorded');
    expect(telnyx.recordingDisclosure).toHaveBeenCalledTimes(1);
  });
  it('a failed announcement records nothing and the rep can try again', async () => {
    (telnyx.recordingDisclosure as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await expect(startManualRecording(principal, call._id)).rejects.toThrow("couldn't start");
    expect(record.state).toBe('failed'); expect(telnyx.recordingCommand).not.toHaveBeenCalled();
    await startManualRecording(principal, call._id); expect(mockRemove).toHaveBeenCalledTimes(1); expect(record.state).toBe('disclosing');
  });
  it('connection events never start a recording by themselves', async () => { await observeRecordingCall('call.bridged', { call_control_id: 'customer', call_session_id: 'session', connection_id: 'connection' }); expect(mockCreate).not.toHaveBeenCalled(); expect(telnyx.recordingCommand).not.toHaveBeenCalled(); });
  it('manual pause is never automatically resumed by connection events', async () => { await announce(); await controlRecording(principal, call._id, 'pause'); await observeRecordingCall('call.bridged', { call_control_id: 'customer', call_session_id: 'session', connection_id: 'connection' }); expect(record.state).toBe('paused'); expect(telnyx.recordingCommand).toHaveBeenCalledTimes(2); });
  it('paused state is only displayed after provider acknowledges', async () => { await announce(); await controlRecording(principal, call._id, 'pause'); expect(record.state).toBe('paused'); expect(record.manualPaused).toBe(true); });
  it('provider pause failure becomes unknown, attempts stop, and leaves the call connected', async () => { await announce(); (telnyx.recordingCommand as jest.Mock).mockRejectedValueOnce(new Error('timeout')); await expect(controlRecording(principal, call._id, 'pause')).rejects.toThrow('unknown'); expect(record.state).toBe('unknown'); expect(record.manualPaused).toBe(true); expect(call.status).toBe('in-progress'); expect(telnyx.recordingCommand).toHaveBeenLastCalledWith('customer', 'stop', expect.any(String)); });
  it('IVR answer is never employee answer evidence', async () => { call.recordingCorrelation.verified = false; delete call.recordingCorrelation.answerControlId; await observeRecordingCall('call.answered', { call_control_id: 'customer', call_session_id: 'session', connection_id: 'connection', client_state: encode({ kind: 'ivr-menu' }) }); expect(call.recordingCorrelation.verified).toBe(false); });
  it('stale IVR agent revision is ignored', async () => { call.routing = { revision: 4 }; call.recordingCorrelation.verified = false; await observeRecordingCall('call.answered', { call_control_id: 'agent', call_session_id: 'session', connection_id: 'sip-connection', client_state: encode({ kind: 'agent-leg', callLogId: call._id, userId: 'rep', revision: 3 }) }); expect(call.recordingCorrelation.verified).toBe(false); });
  it('agent evidence waits until the customer connection is known', async () => { call.recordingCorrelation = {}; await expect(observeRecordingCall('call.answered', { call_control_id: 'agent', call_session_id: 'session', connection_id: 'sip-connection', client_state: encode({ kind: 'agent-leg', callLogId: call._id, userId: 'rep' }) })).rejects.toThrow('pending'); });
  it('the first customer event pins the connection and later mismatches are ignored', async () => { call.recordingCorrelation = {}; await observeRecordingCall('call.initiated', { call_control_id: 'customer', call_session_id: 'session', connection_id: 'connection', call_leg_id: 'customer-leg' }); expect(call.recordingCorrelation.connectionId).toBe('connection'); mockCallUpdate.mockClear(); await observeRecordingCall('call.bridged', { call_control_id: 'customer', call_session_id: 'session', connection_id: 'other' }); expect(mockCallUpdate).not.toHaveBeenCalled(); });
  it('failed disclosure does not record and consumes its speech callback', async () => { await startManualRecording(principal, call._id); expect(await finishRecordingDisclosure({ call_control_id: 'customer', client_state: encode({ recordingDisclosureId: record._id }), status: 'failed' })).toBe(true); expect(record.state).toBe('failed'); expect(telnyx.recordingCommand).not.toHaveBeenCalled(); });
  it('recording notice is separate from unrelated speech', async () => { await startManualRecording(principal, call._id); expect(await finishRecordingDisclosure({ call_control_id: 'customer', client_state: encode({ kind: 'ivr-menu' }) })).toBe(false); expect(record.state).toBe('disclosing'); });
});
