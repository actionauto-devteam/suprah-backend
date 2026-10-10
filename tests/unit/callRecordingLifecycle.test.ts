const mockCallId = jest.fn(); const mockCallFind = jest.fn(); const mockCallUpdate = jest.fn();
const mockPolicy = jest.fn(); const mockRecordFind = jest.fn(); const mockRecordId = jest.fn(); const mockRecordUpdate = jest.fn(); const mockReserve = jest.fn();
jest.mock('../../src/models/communication.model', () => ({ CallLog: { findById: mockCallId, findOne: mockCallFind, updateOne: mockCallUpdate } }));
jest.mock('../../src/models/CallRecording.model', () => ({ CallRecording: { findOne: mockRecordFind, findById: mockRecordId, findOneAndUpdate: mockReserve, updateOne: mockRecordUpdate }, CallRecordingPolicy: { findOne: mockPolicy } }));
jest.mock('../../src/services/callRecordingStorage.service', () => ({}));
jest.mock('../../src/services/callRecordingAccess.service', () => ({ requireRecordingPermission: jest.fn().mockResolvedValue(undefined), recordingAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/telnyx.service', () => ({ recordingCommand: jest.fn().mockResolvedValue({}), recordingDisclosure: jest.fn().mockResolvedValue({}) }));
import { maybeStartRecording, controlRecording, observeRecordingCall, finishRecordingDisclosure } from '../../src/services/callRecording.service';
import * as telnyx from '../../src/services/telnyx.service';
let call: any; let policy: any; let record: any;
const principal: any = { id: 'rep', orgId: 'org', kind: 'crm' };
const encode = (data: any) => Buffer.from(JSON.stringify(data)).toString('base64');
function apply(target: any, update: any) {
  for (const [key, value] of Object.entries(update.$set || {})) { const parts = key.split('.'); const last = parts.pop()!; const parent = parts.reduce((row, part) => row[part] ||= {}, target); parent[last] = value; }
  for (const [key, value] of Object.entries(update.$inc || {})) target[key] = (target[key] || 0) + Number(value);
}
beforeEach(() => {
  jest.clearAllMocks();
  call = { _id: '507f1f77bcf86cd799439021', orgId: 'org', direction: 'inbound', from: '+18015550100', to: '+18015550999', status: 'in-progress', answeredBy: { userId: 'rep' }, providerCallControlId: 'customer', providerCallSessionId: 'session', agentLegCallControlId: 'agent', recordingCorrelation: { verified: true, answerControlId: 'agent', connectionId: 'connection', bridged: true, customerLegId: 'customer-leg' } };
  policy = { name: 'Fixture', number: call.to, direction: 'inbound', enabled: true, retentionMonths: 6, connectionId: 'connection', legalApproved: true, providerVerified: true, disclosureOwner: 'provider', disclosureText: '', disclosureLanguage: 'en-US', providerDisclosureVerified: true, consentMode: 'notice', version: 1 };
  record = { _id: '507f1f77bcf86cd799439031', callLogId: call._id, organizationId: 'org', employeeId: 'rep', state: 'waiting', revision: 0, controlId: 'customer', policy, files: [], manualPaused: false };
  mockCallId.mockImplementation(() => ({ select: async () => structuredClone(call) }));
  mockCallFind.mockImplementation(() => ({ select: async () => structuredClone(call), then: (resolve: any) => resolve(structuredClone(call)) }));
  mockPolicy.mockImplementation(() => ({ lean: async () => structuredClone(policy) }));
  mockRecordId.mockImplementation(async () => structuredClone(record)); mockRecordFind.mockImplementation(async query => query.state && query.state !== record.state ? null : structuredClone(record));
  mockReserve.mockImplementation(async (query, update) => { if (query.revision !== undefined && (query.revision !== record.revision || query.state !== record.state)) return null; apply(record, update); return structuredClone(record); });
  mockRecordUpdate.mockImplementation(async (query, update) => { if (query.revision === undefined || query.revision === record.revision) apply(record, update); return {}; });
  mockCallUpdate.mockImplementation(async (_query, update) => { apply(call, update); return {}; });
  (telnyx.recordingCommand as jest.Mock).mockResolvedValue({}); (telnyx.recordingDisclosure as jest.Mock).mockResolvedValue({});
});
describe('Mocked recording lifecycle', () => {
  it('starts once and targets the customer control leg', async () => { await maybeStartRecording(call._id); await maybeStartRecording(call._id); expect(telnyx.recordingCommand).toHaveBeenCalledTimes(1); expect(telnyx.recordingCommand).toHaveBeenCalledWith('customer', 'start', expect.any(String)); expect(record.state).toBe('recording'); });
  it('manual pause is never automatically resumed by connection events', async () => { record.state = 'paused'; record.manualPaused = true; await maybeStartRecording(call._id); expect(record.state).toBe('paused'); expect(telnyx.recordingCommand).not.toHaveBeenCalled(); });
  it('paused state is only displayed after provider acknowledges', async () => { record.state = 'recording'; await controlRecording(principal, call._id, 'pause'); expect(record.state).toBe('paused'); expect(record.manualPaused).toBe(true); });
  it('provider pause failure becomes unknown, attempts stop, and leaves the call connected', async () => { record.state = 'recording'; (telnyx.recordingCommand as jest.Mock).mockRejectedValueOnce(new Error('timeout')); await expect(controlRecording(principal, call._id, 'pause')).rejects.toThrow('unknown'); expect(record.state).toBe('unknown'); expect(record.manualPaused).toBe(true); expect(call.status).toBe('in-progress'); expect(telnyx.recordingCommand).toHaveBeenLastCalledWith('customer', 'stop', expect.any(String)); });
  it('IVR answer is never employee answer evidence', async () => { call.recordingCorrelation.verified = false; delete call.recordingCorrelation.answerControlId; await observeRecordingCall('call.answered', { call_control_id: 'customer', call_session_id: 'session', connection_id: 'connection', client_state: encode({ kind: 'ivr-menu' }) }); expect(telnyx.recordingCommand).not.toHaveBeenCalled(); });
  it('stale IVR agent revision is ignored', async () => { call.routing = { revision: 4 }; call.recordingCorrelation.verified = false; await observeRecordingCall('call.answered', { call_control_id: 'agent', call_session_id: 'session', connection_id: 'sip-connection', client_state: encode({ kind: 'agent-leg', callLogId: call._id, userId: 'rep', revision: 3 }) }); expect(telnyx.recordingCommand).not.toHaveBeenCalled(); });
  it('disabled and invalid policy cannot start recording', async () => { policy.enabled = true; policy.legalApproved = false; await maybeStartRecording(call._id); expect(telnyx.recordingCommand).not.toHaveBeenCalled(); });
  it('failed disclosure does not record and consumes its speech callback', async () => { record.state = 'disclosing'; expect(await finishRecordingDisclosure({ call_control_id: 'customer', client_state: encode({ recordingDisclosureId: record._id }), status: 'failed' })).toBe(true); expect(record.state).toBe('failed'); expect(telnyx.recordingCommand).not.toHaveBeenCalled(); });
  it('recording notice is separate from unrelated speech', async () => { record.state = 'disclosing'; expect(await finishRecordingDisclosure({ call_control_id: 'customer', client_state: encode({ kind: 'ivr-menu' }) })).toBe(false); expect(record.state).toBe('disclosing'); });
});
