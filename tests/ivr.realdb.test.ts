import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';

const mockEmit = jest.fn();
const mockGlobalEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
const mockIo = { to: mockTo, emit: mockGlobalEmit };
jest.mock('../src/utils/socketEmitter', () => ({ getSocketIO: () => mockIo, emitToOrg: jest.fn() }));
jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999', answerCall: jest.fn().mockResolvedValue({}),
  gatherIvr: jest.fn().mockResolvedValue({}), speakIvr: jest.fn().mockResolvedValue({}),
  transferToAgent: jest.fn().mockResolvedValue({}), hangupCall: jest.fn().mockResolvedValue({}),
  playMissedAndHangup: jest.fn().mockResolvedValue({}), sendSms: jest.fn().mockResolvedValue({ id: 'test-sms' }),
}));
jest.mock('../src/utils/safeNotification', () => ({ notifyOrgAdmins: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/utils/aiAgentTask', () => ({ createAiAgentTaskAndNotify: jest.fn() }));
jest.mock('../src/utils/leadNote', () => ({ addLeadNoteAndNotify: jest.fn() }));
jest.mock('../src/services/aiAgent.service', () => ({ resolveAiAgentSettings: jest.fn().mockResolvedValue({}), processAlexTurn: jest.fn(), HISTORY_LIMIT: 12 }));

import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import CustomerIdentityLock from '../src/models/CustomerIdentityLock.model';
import CrmLeadGroup from '../src/models/CrmLeadGroup.model';
import CallRoutingConfig, { IvrInboundClaim, RoutingConfig } from '../src/models/CallRoutingConfig.model';
import { CallLog, Conversation, CommunicationMessage, TelephonyCredential } from '../src/models/communication.model';
import { getInboundRoutingConfig, routingGroupRecipients, validateRoutingGroups } from '../src/services/callRoutingConfig.service';
import { initializeIvr, handleIvrGather, expireIvr, recoverIvrCalls, clearIvrTimer } from '../src/services/ivr.service';
import * as comm from '../src/services/communication.service';
import * as telnyx from '../src/services/telnyx.service';
import { listRingingCalls } from '../src/controllers/communication.controller';
import { listRoutingConfigs, saveRoutingConfig } from '../src/controllers/callRoutingConfig.controller';

let orgId: string;
let otherOrgId: string;
let userIds: string[];
let crmIds: string[];
let groupIds: string[];
let config: RoutingConfig;
let serial = 0;
let now: number;
const missed = jest.fn().mockResolvedValue(undefined);
const callbacks = { missed };

function tag(kind: string, call: any, revision = call.routing?.revision) {
  return Buffer.from(JSON.stringify({ kind, callLogId: String(call._id), revision })).toString('base64');
}
function gather(call: any, digits: string) {
  return { call_control_id: call.providerCallControlId, client_state: tag('ivr-menu', call), digits, status: digits ? 'valid' : 'timeout' };
}
async function freshCall() {
  const phone = `+1801555${String(++serial).padStart(4, '0')}`;
  const lead = await Lead.create({ organizationId: orgId, createdBy: userIds[0], firstName: 'IVR Test', lastName: 'Fixture', phone, channel: 'phone', source: 'Phone Call', location: 'Existing' });
  const call = await CallLog.create({ orgId, direction: 'inbound', from: phone, to: config.inboundNumber, status: 'ivr',
    leadId: lead._id, providerCallControlId: `ivr-test-${now}-${serial}`, providerCallSessionId: `session-${now}-${serial}` });
  await initializeIvr(call, config, callbacks);
  return CallLog.findById(call._id);
}
async function select(digit: string) {
  const call = await freshCall(); await handleIvrGather(gather(call, digit), callbacks);
  return CallLog.findById(call._id);
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.orgId = orgId;
  req.crmUser = { _id: req.header('x-user') || crmIds?.[0], role: req.header('x-role') || 'admin' } as any;
  next();
});
app.get('/ringing', listRingingCalls);
app.get('/configs', listRoutingConfigs);
app.post('/configs', saveRoutingConfig);
app.put('/configs/:id', saveRoutingConfig);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

beforeAll(async () => {
  now = Date.now();
  await Promise.all([CallRoutingConfig.init(), IvrInboundClaim.init()]);
  const org = await Organization.create({ name: 'Stage 41B Test', slug: `ivr-test-${now}`, status: 'active' });
  const other = await Organization.create({ name: 'Stage 41B Other', slug: `ivr-other-${now}`, status: 'active' });
  orgId = String(org._id); otherOrgId = String(other._id);
  userIds = []; crmIds = []; groupIds = [];
  for (let i = 0; i < 6; i++) {
    const email = `ivr-${now}-${i}@example.com`;
    const user = await User.create({ organizationId: orgId, email, name: `Handler ${i}`, role: 'admin', password: 'Password123!', isActive: true });
    const crm = await CrmUser.create({ organizationId: orgId, email, fullName: `Handler ${i}`, username: `ivr-${now}-${i}`, role: 'admin', password: 'Password123!', isActive: true });
    const group = await CrmLeadGroup.create({ organizationId: orgId, name: `Route ${i}`, memberIds: [user._id], createdBy: crm._id });
    userIds.push(String(user._id)); crmIds.push(String(crm._id)); groupIds.push(String(group._id));
    await TelephonyCredential.create({ userId: String(crm._id), credentialId: `test-${now}-${i}`, sipUsername: `test-${i}` });
  }
  config = {
    enabled: true, name: 'Test IVR', inboundNumber: '+18015550888', mainNumber: '+18017666137', greeting: 'Press 0 to 4',
    ringTimeoutSeconds: 35, retryCount: 1, receptionGroupId: groupIds[0], allOrgFallback: false,
    options: [
      { digit: '0', label: 'Spanish', type: 'language', groupId: null, leadLocation: '', language: 'Spanish', externalDestination: '' },
      { digit: '1', label: 'Orem', type: 'location', groupId: groupIds[1], leadLocation: 'Orem', language: '', externalDestination: '' },
      { digit: '2', label: 'Lehi', type: 'location', groupId: groupIds[2], leadLocation: 'Lehi', language: '', externalDestination: '' },
      { digit: '3', label: 'Service', type: 'department', groupId: groupIds[3], leadLocation: '', language: '', externalDestination: '+18018752782' },
      { digit: '4', label: 'Title/Licensing', type: 'department', groupId: groupIds[4], leadLocation: '', language: '', externalDestination: '' },
    ],
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Live network forbidden in IVR tests'));
  process.env.COMM_ORG_ID = orgId;
});
afterEach(async () => {
  if (mongoose.connection.readyState !== 1 || !orgId) { jest.restoreAllMocks(); return; }
  const calls = await CallLog.find({ orgId }).select('_id');
  for (const call of calls) clearIvrTimer(String(call._id));
  await CallLog.updateMany({ orgId, status: { $in: ['ivr', 'ringing', 'answering'] } }, { $set: { status: 'canceled', 'routing.deadline': null } });
  jest.restoreAllMocks();
});
afterAll(async () => {
  if (!orgId || mongoose.connection.readyState !== 1) { await mongoose.disconnect(); return; }
  await Promise.all([
    CallLog.deleteMany({ orgId }), Conversation.deleteMany({ orgId }), CommunicationMessage.deleteMany({ orgId }),
    Lead.deleteMany({ organizationId: orgId }), CallRoutingConfig.deleteMany({ organizationId: orgId }),
    Customer.deleteMany({ organizationId: orgId }), CustomerIdentityLock.deleteMany({ organizationId: orgId }),
    IvrInboundClaim.deleteMany({ organizationId: orgId }), CrmLeadGroup.deleteMany({ organizationId: orgId }),
    TelephonyCredential.deleteMany({ userId: { $in: crmIds } }),
    User.deleteMany({ organizationId: orgId }), CrmUser.deleteMany({ organizationId: orgId }),
    Organization.deleteMany({ _id: { $in: [orgId, otherOrgId] } }),
  ]);
  await mongoose.disconnect();
});

describe('Stage 41B local MongoDB verification', () => {
  it('resolves main and CRM identities within the organization', async () => {
    expect(await routingGroupRecipients(orgId, groupIds[1])).toEqual(expect.arrayContaining([userIds[1], crmIds[1]]));
    expect(await routingGroupRecipients(otherOrgId, groupIds[1])).toEqual([]);
    await expect(validateRoutingGroups(otherOrgId, config)).rejects.toThrow('this organization');
  });
  it.each(['0', '1', '2', '3', '4'])('persists digit %s routing and correct Lead location', async digit => {
    const call = await select(digit);
    expect(call.status).toBe('ringing'); expect(call.routing.targetGroupId).toBe(groupIds[Number(digit)]);
    expect(call.routing.recipientIds).toContain(crmIds[Number(digit)]);
    const lead = await Lead.findById(call.leadId);
    expect(lead.location).toBe(digit === '1' ? 'Orem' : digit === '2' ? 'Lehi' : 'Existing');
    expect(mockTo).toHaveBeenCalledWith(expect.arrayContaining([`user:${crmIds[Number(digit)]}`]));
    expect(mockIo.emit).not.toHaveBeenCalledWith('comm:call:incoming', expect.anything());
    expect(telnyx.transferToAgent).not.toHaveBeenCalled();
    if (digit === '0') expect(call.routing.language).toBe('Spanish');
  });
  it('does not notify anyone before route selection or hang up after the menu/hold speech', async () => {
    const call = await freshCall(); expect(mockEmit).not.toHaveBeenCalled();
    await comm.handleSpeakEnded({ call_control_id: call.providerCallControlId, client_state: tag('ivr-menu', call) });
    expect(telnyx.hangupCall).not.toHaveBeenCalled();
    await handleIvrGather(gather(call, '1'), callbacks);
    await comm.handleSpeakEnded({ call_control_id: call.providerCallControlId, client_state: tag('ivr-hold', call) });
    expect(telnyx.hangupCall).not.toHaveBeenCalled();
  });
  it('ringing recovery hides calls from other groups and claims reject non-members', async () => {
    const call = await select('2');
    const outsider = await request(app).get('/ringing').set('x-user', crmIds[5]);
    expect(outsider.status).toBe(200); expect(outsider.body.data.items.map((item: any) => item._id)).not.toContain(String(call._id));
    const member = await request(app).get('/ringing').set('x-user', crmIds[2]);
    expect(member.body.data.items.map((item: any) => item._id)).toContain(String(call._id));
    await expect(comm.claimInboundCall({ callId: String(call._id), orgId, user: { userId: crmIds[5] } })).rejects.toMatchObject({ statusCode: 403 });
    const claims = await Promise.allSettled([0, 1].map(() => comm.claimInboundCall({ callId: String(call._id), orgId, user: { userId: crmIds[2] } })));
    expect(claims.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(telnyx.transferToAgent).toHaveBeenCalledTimes(1);
    await expect(comm.claimInboundCall({ callId: String(call._id), orgId: otherOrgId, user: { userId: crmIds[2] } })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('distinguishes IVR answer from employee answer and ignores stale agent events', async () => {
    const call = await freshCall();
    await comm.handleCallAnswered({ call_session_id: call.providerCallSessionId, client_state: tag('ivr-customer', call) });
    expect((await CallLog.findById(call._id)).status).toBe('ivr');
    await handleIvrGather(gather(call, '1'), callbacks);
    const selected = await CallLog.findById(call._id);
    await comm.claimInboundCall({ callId: String(call._id), orgId, user: { userId: crmIds[1] } });
    await comm.handleCallAnswered({ call_session_id: call.providerCallSessionId, call_control_id: 'agent', client_state: tag('agent-leg', selected, selected.routing.revision - 1) });
    expect((await CallLog.findById(call._id)).status).toBe('answering');
    await comm.handleCallAnswered({ call_session_id: call.providerCallSessionId, call_control_id: 'agent', client_state: tag('agent-leg', selected) });
    expect((await CallLog.findById(call._id)).status).toBe('in-progress');
    await comm.handleCallInitiated({ direction: 'outgoing', call_session_id: call.providerCallSessionId, call_control_id: 'agent', client_state: tag('agent-leg', selected) });
    expect(telnyx.hangupCall).not.toHaveBeenCalled();
  });
  it('invalid/no input replays once then routes to Reception, ignoring repeated delivery', async () => {
    const call = await freshCall(); const invalid = gather(call, '9');
    await Promise.all([handleIvrGather(invalid, callbacks), handleIvrGather(invalid, callbacks)]);
    const retried = await CallLog.findById(call._id); expect(retried.routing.attempts).toBe(1);
    expect(telnyx.gatherIvr).toHaveBeenCalledTimes(2);
    await handleIvrGather(gather(retried, ''), callbacks);
    expect((await CallLog.findById(call._id)).routing.stage).toBe('reception');
  });
  it('selected timeout goes to Reception; final timeout invokes missed only once', async () => {
    const call = await select('1');
    await expireIvr(String(call._id), call.routing.revision, callbacks);
    const reception = await CallLog.findById(call._id); expect(reception.routing.stage).toBe('reception');
    await Promise.all([expireIvr(String(call._id), reception.routing.revision, callbacks), expireIvr(String(call._id), reception.routing.revision, callbacks)]);
    expect((await CallLog.findById(call._id)).status).toBe('missed'); expect(missed).toHaveBeenCalledTimes(1);
  });
  it('all-org fallback requires opt-in and follows Reception', async () => {
    const original = config; config = { ...config, allOrgFallback: true };
    try {
      const call = await select('0'); await expireIvr(String(call._id), call.routing.revision, callbacks);
      const fallback = await CallLog.findById(call._id);
      expect(fallback.routing.stage).toBe('all-org'); expect(fallback.routing.allOrg).toBe(true);
      const outsider = await request(app).get('/ringing').set('x-user', crmIds[5]);
      expect(outsider.body.data.items.map((item: any) => item._id)).toContain(String(call._id));
    } finally { config = original; }
  });
  it('falls back when a selected group becomes inactive', async () => {
    const call = await freshCall(); await CrmLeadGroup.updateOne({ _id: groupIds[3] }, { $set: { isActive: false } });
    try {
      await handleIvrGather(gather(call, '3'), callbacks);
      expect((await CallLog.findById(call._id)).routing.stage).toBe('reception');
    } finally { await CrmLeadGroup.updateOne({ _id: groupIds[3] }, { $set: { isActive: true } }); }
  });
  it('recovers persisted expired deadlines after losing the in-memory timer', async () => {
    const call = await select('4'); clearIvrTimer(String(call._id));
    await CallLog.updateOne({ _id: call._id }, { $set: { 'routing.deadline': new Date(Date.now() - 1000) } });
    await recoverIvrCalls(callbacks, orgId);
    expect((await CallLog.findById(call._id)).routing.stage).toBe('reception');
  });
  it('preserves legacy ringing if answer or initial gather cannot initialize safely', async () => {
    (telnyx.answerCall as jest.Mock).mockRejectedValueOnce(new Error('answer timeout'));
    const failedAnswer = await freshCall();
    expect(failedAnswer.routing.allOrg).toBe(true); expect(failedAnswer.status).toBe('ringing');
    (telnyx.gatherIvr as jest.Mock).mockRejectedValueOnce(new Error('gather timeout'));
    const failedGather = await freshCall();
    expect(failedGather.routing.allOrg).toBe(true); expect(failedGather.status).toBe('ringing');
  });
  it('creates and links a new inbound Lead before DTMF, then applies the selected location', async () => {
    await CallRoutingConfig.create({ ...config, organizationId: orgId, updatedBy: crmIds[0] });
    try {
      const phone = `+1801${String(now).slice(-7)}`;
      const payload = { direction: 'incoming', call_control_id: `new-lead-${now}`, call_session_id: `new-lead-session-${now}`, from: phone, to: config.inboundNumber };
      await comm.handleCallInitiated(payload);
      const call = await CallLog.findOne({ orgId, providerCallControlId: payload.call_control_id });
      expect(call.status).toBe('ivr'); expect(call.leadId).toBeTruthy();
      const lead = await Lead.findById(call.leadId); expect(lead.phone).toBe(phone);
      const conversation = await Conversation.findById(call.conversationId); expect(String(conversation.leadId)).toBe(String(lead._id));
      await comm.handleCallGatherEnded(gather(call, '1'));
      expect((await Lead.findById(lead._id)).location).toBe('Orem');
    } finally { await CallRoutingConfig.deleteMany({ organizationId: orgId }); }
  });
  it('saves admin config; rejects non-admin, foreign groups, loops and external activation', async () => {
    expect((await request(app).get('/configs').set('x-role', 'employee')).status).toBe(403);
    expect((await request(app).post('/configs').set('x-role', 'manager').send(config)).status).toBe(403);
    const response = await request(app).post('/configs').send(config); expect(response.status).toBe(200);
    expect(response.body.data.enabled).toBe(true);
    const id = response.body.data._id;
    for (const destination of [config.mainNumber, config.inboundNumber, '+18015550999']) {
      const bad = { ...config, options: config.options.map(option => ({ ...option, externalDestination: destination })) };
      expect((await request(app).put(`/configs/${id}`).send(bad)).status).toBe(400);
    }
    expect((await request(app).put(`/configs/${id}`).send({ ...config, externalTransferEnabled: true })).status).toBe(400);
    expect((await getInboundRoutingConfig(config.inboundNumber))?.orgId).toBe(orgId);
    await CallRoutingConfig.updateOne({ _id: id }, { $set: { enabled: false } });
    expect(await getInboundRoutingConfig(config.inboundNumber)).toBeNull();
    await CallRoutingConfig.deleteOne({ _id: id });
  });
  it('duplicate inbound/gather webhooks create one CallLog and select one route', async () => {
    await CallRoutingConfig.create({ ...config, organizationId: orgId, updatedBy: crmIds[0] });
    const control = `dedup-${now}`;
    const payload = { direction: 'incoming', call_control_id: control, call_session_id: `dedup-session-${now}`, from: '+18015550777', to: config.inboundNumber };
    await Lead.create({ organizationId: orgId, createdBy: userIds[0], firstName: 'Duplicate', phone: payload.from, channel: 'phone', source: 'Phone Call' });
    await Promise.all([comm.handleCallInitiated(payload), comm.handleCallInitiated(payload)]);
    expect(await CallLog.countDocuments({ orgId, providerCallControlId: control })).toBe(1);
    expect(telnyx.answerCall).toHaveBeenCalledTimes(1);
    const call = await CallLog.findOne({ orgId, providerCallControlId: control });
    const event = gather(call, '2'); await Promise.all([comm.handleCallGatherEnded(event), comm.handleCallGatherEnded(event)]);
    const selected = await CallLog.findById(call._id);
    expect(selected.routing.selectedDigit).toBe('2'); expect(selected.routing.history.filter((entry: any) => entry.reason === 'digit-selected')).toHaveLength(1);
    await comm.recoverPendingIvrCalls(orgId);
    await CallLog.updateOne({ _id: call._id }, { $set: { 'routing.deadline': new Date(Date.now() - 1000) } });
    await comm.recoverPendingIvrCalls(orgId);
    await CallLog.updateOne({ _id: call._id }, { $set: { 'routing.deadline': new Date(Date.now() - 1000) } });
    await Promise.all([comm.recoverPendingIvrCalls(orgId), comm.recoverPendingIvrCalls(orgId)]);
    expect((await CallLog.findById(call._id)).textBackSentAt).toBeTruthy();
    expect(telnyx.sendSms).toHaveBeenCalledTimes(1);
    await comm.handleCallHangup({ call_session_id: call.providerCallSessionId, call_control_id: control, hangup_cause: 'normal_clearing' });
    expect(telnyx.sendSms).toHaveBeenCalledTimes(1);
    await comm.handleSpeakEnded({ call_control_id: control, client_state: tag('ivr-missed', await CallLog.findById(call._id)) });
    expect(telnyx.hangupCall).toHaveBeenCalledWith(control);
    await CallRoutingConfig.deleteMany({ organizationId: orgId });
  });
  it('missing, disabled and invalid configs leave inbound calling on legacy ringing', async () => {
    for (const mode of ['missing', 'disabled', 'invalid']) {
      const number = `+1801${String(now).slice(-6)}${mode === 'missing' ? '1' : mode === 'disabled' ? '2' : '3'}`;
      if (mode !== 'missing') await CallRoutingConfig.create({ ...config, organizationId: orgId, updatedBy: crmIds[0], inboundNumber: number, enabled: mode === 'invalid', ...(mode === 'invalid' ? { receptionGroupId: null } : {}) });
      const payload = { direction: 'incoming', call_control_id: `legacy-${now}-${mode}`, call_session_id: `legacy-session-${now}-${mode}`, from: `+18015550${mode === 'missing' ? '201' : mode === 'disabled' ? '202' : '203'}`, to: number };
      await Lead.create({ organizationId: orgId, createdBy: userIds[0], firstName: 'Legacy', phone: payload.from, channel: 'phone', source: 'Phone Call' });
      if (mode !== 'missing') process.env.COMM_ORG_ID = otherOrgId;
      await comm.handleCallInitiated(payload);
      const call = await CallLog.findOne({ orgId, providerCallControlId: payload.call_control_id });
      expect(call.status).toBe('ringing'); expect(call.routing).toBeUndefined();
      expect(String(call.orgId)).toBe(orgId);
      process.env.COMM_ORG_ID = orgId;
      await comm.handleCallHangup({ call_session_id: payload.call_session_id, call_control_id: payload.call_control_id, hangup_cause: 'normal_clearing' });
    }
    expect(telnyx.gatherIvr).not.toHaveBeenCalled();
  });
});
