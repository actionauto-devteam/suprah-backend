import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Readable } from 'stream';
jest.mock('../src/config', () => ({ __esModule: true, default: { bcryptSaltRounds: 4, jwt: { accessSecret: 'local-recording-access', refreshSecret: 'local-recording-refresh', accessExpiration: '15m', refreshExpiration: '7d' } } }));
jest.mock('../src/services/telnyx.service', () => ({ recordingCommand: jest.fn().mockResolvedValue({}), recordingDisclosure: jest.fn().mockResolvedValue({}), findRecordings: jest.fn().mockResolvedValue([]), deleteProviderRecording: jest.fn().mockResolvedValue({}), hangupCall: jest.fn().mockResolvedValue({}), deleteRecordingTranscription: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/callSummary.service', () => ({ summarizeCallTranscript: jest.fn().mockResolvedValue({ points: ['Customer asked if the Tacoma is still available.', 'Rep offered a test drive on Saturday.'], sentiment: 'Interested and friendly.' }) }));
jest.mock('../src/services/callRecordingStorage.service', () => ({ importRecordingFile: jest.fn().mockResolvedValue({ bytes: 8, checksum: 'test' }), deleteRecordingFile: jest.fn().mockResolvedValue(undefined), streamRecordingFile: jest.fn(async () => ({ stream: Readable.from(Buffer.from('test-mp3')), length: 8, type: 'audio/mpeg' })) }));
import CrmUser from '../src/models/CrmUser.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import { CallLog } from '../src/models/communication.model';
import { CallRecording, CallRecordingPolicy, CallRecordingSettings, CallRecordingGrant, CallRecordingAudit, CallRecordingEvent, CallRecordingShare, CallRecordingMediaSession, DEFAULT_RECORDING_ANNOUNCEMENT } from '../src/models/CallRecording.model';
import { recordingPrincipal, requireRecordingPermission } from '../src/services/callRecordingAccess.service';
import { startManualRecording, observeRecordingCall, createOutboundCorrelation, controlRecording, finishRecordingDisclosure, enqueueRecordingEvent, recoverRecordings, startVoicemailRecording } from '../src/services/callRecording.service';
import * as provider from '../src/services/telnyx.service';
import * as storage from '../src/services/callRecordingStorage.service';
import * as callSummary from '../src/services/callSummary.service';
import * as ctrl from '../src/controllers/callRecording.controller';
import crmAuth, { issueCrmSessionToken } from '../src/middleware/crmAuth.middleware';
import Session from '../src/models/Session.model';
let org: string; let otherOrg: string; let rep: any; let rep2: any; let boss: any; let outsider: any; let serial = 0;
const stamp = Date.now();
const encode = (tag: any) => Buffer.from(JSON.stringify(tag)).toString('base64');
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use((req, _res, next) => { req.orgId = req.header('x-org') || org; req.crmUser = { _id: req.header('x-user') || boss?._id, role: 'admin' } as any; next(); });
app.get('/access', ctrl.getAccess); app.get('/settings', ctrl.getSettings); app.put('/settings', ctrl.saveSettings); app.put('/grants', ctrl.saveGrant);
app.get('/calls/:id', ctrl.getCallRecording); app.get('/recordings', ctrl.listRecordings); app.get('/recordings/:id', ctrl.getRecording);
app.post('/calls/:id/control', ctrl.control);
app.post('/recordings/:id/media', (req, res, next) => req.cookies?.crm_token ? crmAuth()(req, res, next) : next(), ctrl.createMediaSession); app.get('/api/crm/communications/recordings/media/:id', ctrl.mediaSession);
app.post('/recordings/:id/shares', ctrl.createShare); app.get('/shares/:id', ctrl.resolveShare); app.delete('/shares/:id', ctrl.revokeShare);
app.post('/recordings/:id/review', ctrl.reviewRecording);
app.post('/recordings/:id/retry', ctrl.retryImport);
app.delete('/recordings/:id', ctrl.removeRecording);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ message: err.message }));
async function call(direction = 'inbound', values: any = {}) {
  const i = ++serial;
  return CallLog.create({ orgId: org, direction, from: direction === 'inbound' ? '+18015550123' : '+18015550999', to: direction === 'inbound' ? '+18015550999' : '+18015550123', status: 'in-progress', providerCallControlId: `customer-${stamp}-${i}`, providerCallSessionId: `session-${stamp}-${i}`, agentLegCallControlId: `agent-${stamp}-${i}`, placedBy: { userId: rep._id, name: 'Recording Rep' }, answeredBy: direction === 'inbound' ? { userId: rep._id, name: 'Recording Rep' } : undefined, recordingCorrelation: { verified: true, connectionId: 'customer-connection', answerControlId: direction === 'inbound' ? `agent-${stamp}-${i}` : `customer-${stamp}-${i}`, bridged: true, customerLegId: `customer-leg-${i}`, legId: `customer-leg-${i}` }, ...values });
}
async function startRecording(c: any, user: any = rep) {
  const started: any = await startManualRecording(await recordingPrincipal(String(user._id), org), String(c._id));
  await finishRecordingDisclosure({ call_control_id: started.controlId, client_state: encode({ recordingDisclosureId: String(started._id) }), status: 'completed' });
  return CallRecording.findById(started._id);
}
async function finishCall(c: any, r: any, recordingId: string) {
  const end = new Date(); await CallLog.updateOne({ _id: c._id }, { $set: { status: 'completed', endedAt: end } });
  await observeRecordingCall('call.hangup', { call_session_id: c.providerCallSessionId, call_control_id: c.providerCallControlId, connection_id: 'customer-connection' });
  await enqueueRecordingEvent(`recording-test-${stamp}-${recordingId}`, 'call.recording.saved', { call_session_id: c.providerCallSessionId, call_leg_id: r.legId, connection_id: 'customer-connection', recording_id: `${recordingId}-${stamp}`, recording_started_at: r.startedAt.toISOString(), recording_ended_at: end.toISOString(), recording_urls: { mp3: 'https://bucket.s3.amazonaws.com/file.mp3' } });
  await recoverRecordings();
  return CallRecording.findById(r._id);
}
beforeAll(async () => {
  org = String(new mongoose.Types.ObjectId()); otherOrg = String(new mongoose.Types.ObjectId());
  await Promise.all([CallRecording.init(), CallRecordingSettings.init(), CallRecordingEvent.init(), CallRecordingGrant.init()]);
  rep = await CrmUser.create({ organizationId: org, email: `recording-rep-${stamp}@example.com`, fullName: 'Recording Rep', username: `recording-rep-${stamp}`, role: 'employee', department: 'Sales', password: 'Password123!', isActive: true });
  rep2 = await CrmUser.create({ organizationId: org, email: `recording-rep2-${stamp}@example.com`, fullName: 'Second Rep', username: `recording-rep2-${stamp}`, role: 'employee', department: 'Service', password: 'Password123!', isActive: true });
  boss = await CrmUser.create({ organizationId: org, email: `recording-admin-${stamp}@example.com`, fullName: 'Recording Admin', username: `recording-admin-${stamp}`, role: 'admin', password: 'Password123!', isActive: true });
  outsider = await User.create({ organizationId: org, email: `recording-outsider-${stamp}@example.com`, name: 'Employee', role: 'employee', personalInfo: { department: 'QA' }, password: 'Password123!', isActive: true });
  await CallRecordingGrant.create({ organizationId: org, principalId: String(boss._id), principalKind: 'crm', permissions: ['view', 'download', 'share', 'review', 'delete'] });
});
beforeEach(async () => { jest.clearAllMocks(); await CallRecordingSettings.deleteMany({ organizationId: org }); (provider.recordingCommand as jest.Mock).mockResolvedValue({}); (provider.recordingDisclosure as jest.Mock).mockResolvedValue({}); (provider.findRecordings as jest.Mock).mockResolvedValue([]); });
afterAll(async () => {
  const recordings: any[] = await CallRecording.find({ organizationId: org });
  await CallRecordingEvent.deleteMany({ eventId: { $regex: `^(reconcile-)?recording-test-${stamp}` } });
  for (const model of [CallRecording, CallRecordingPolicy, CallRecordingSettings, CallRecordingGrant, CallRecordingAudit, CallRecordingShare, CallRecordingMediaSession]) await model.deleteMany({ organizationId: org });
  await CallLog.deleteMany({ orgId: org }); await Lead.deleteMany({ organizationId: org }); await Customer.deleteMany({ organizationId: org }); await CrmUser.deleteMany({ _id: { $in: [rep._id, rep2._id, boss._id] } }); await User.deleteOne({ _id: outsider._id });
  await Session.deleteMany({ crmUserId: { $in: [rep._id, rep2._id, boss._id] } });
  expect(recordings.length).toBeGreaterThan(0);
  await mongoose.disconnect();
});
describe('Call recordings on local MongoDB', () => {
  it('returns real staff metadata, the default settings and preserves explicitly granted linked main identities', async () => {
    const linked = await User.create({ organizationId: org, email: boss.email, name: 'Linked Admin', role: 'admin', password: 'Password123!', isActive: true });
    try {
      let response = await request(app).get('/settings'); expect(response.status).toBe(200);
      expect(response.body.data.settings).toEqual({ announcementText: DEFAULT_RECORDING_ANNOUNCEMENT, retentionMonths: 6, autoRecord: true });
      expect(response.body.data.permissions).toEqual(['view', 'download', 'share', 'review', 'delete']);
      expect(response.body.data.staff.find((u: any) => u.id === String(rep._id))).toMatchObject({ kind: 'crm', role: 'employee', department: 'Sales' });
      expect(response.body.data.staff.find((u: any) => u.id === String(outsider._id))).toMatchObject({ kind: 'main', role: 'employee', department: 'QA' });
      expect(response.body.data.staff.some((u: any) => u.id === String(linked._id))).toBe(false);
      await CallRecordingGrant.create({ organizationId: org, principalId: String(linked._id), principalKind: 'main', permissions: ['view'] });
      response = await request(app).get('/settings');
      expect(response.body.data.staff.find((u: any) => u.id === String(linked._id))).toMatchObject({ kind: 'main', role: 'admin', email: boss.email });
      expect(response.body.data.staff.some((u: any) => u.id === String(boss._id) && u.kind === 'crm')).toBe(true);
    } finally { await User.deleteOne({ _id: linked._id }); await CallRecordingGrant.deleteOne({ organizationId: org, principalId: String(linked._id) }); }
  });
  it('saves the announcement and how long recordings are kept; only admins, with plain-language limits', async () => {
    expect((await request(app).put('/settings').send({ announcementText: '  This call is recorded for training.  ', retentionMonths: 12 })).status).toBe(200);
    expect(await CallRecordingSettings.findOne({ organizationId: org }).lean()).toMatchObject({ announcementText: 'This call is recorded for training.', retentionMonths: 12 });
    expect((await request(app).put('/settings').set('x-user', String(rep._id)).send({ announcementText: 'x', retentionMonths: 6 })).status).toBe(403);
    const blank = await request(app).put('/settings').send({ announcementText: '   ', retentionMonths: 6 }); expect(blank.status).toBe(400); expect(blank.body.message).toContain('announcement');
    expect((await request(app).put('/settings').send({ announcementText: 'ok', retentionMonths: 0 })).status).toBe(400);
    expect((await request(app).put('/settings').send({ announcementText: 'x'.repeat(301), retentionMonths: 6 })).status).toBe(400);
    expect((await request(app).put('/settings').send({ announcementText: 'ok', retentionMonths: 6, enabled: true })).status).toBe(400);
    expect((await request(app).put('/settings').send({ announcementText: 'ok', retentionMonths: 6, autoRecord: false })).status).toBe(200);
    expect((await request(app).get('/settings')).body.data.settings.autoRecord).toBe(false);
    expect((await request(app).put('/settings').send({ announcementText: 'ok', retentionMonths: 6, autoRecord: 'yes' })).status).toBe(400);
  });
  it('saves a full permission set in one audited update, drops the old pause/resume permission and revokes through an empty set', async () => {
    const input = { principalId: String(outsider._id), principalKind: 'main', permissions: ['view', 'review', 'download', 'share', 'control', 'delete'] };
    const before = await CallRecordingAudit.countDocuments({ organizationId: org, action: 'permission.changed' });
    try {
      expect((await request(app).put('/grants').send(input)).status).toBe(200);
      expect((await CallRecordingGrant.findOne({ organizationId: org, principalId: input.principalId })).permissions).toEqual(['view', 'review', 'download', 'share', 'delete']);
      expect(await CallRecordingAudit.countDocuments({ organizationId: org, action: 'permission.changed' })).toBe(before + 1);
      expect((await request(app).put('/grants').send({ ...input, permissions: [] })).status).toBe(200);
      expect((await CallRecordingGrant.findOne({ organizationId: org, principalId: input.principalId })).permissions).toEqual([]);
    } finally { await CallRecordingGrant.deleteOne({ organizationId: org, principalId: input.principalId }); }
  });
  it('rejects non-admin grant changes, foreign targets and invented permission keys', async () => {
    const input = { principalId: String(rep._id), principalKind: 'crm', permissions: ['view'] };
    expect((await request(app).put('/grants').set('x-user', String(rep._id)).send(input)).status).toBe(403);
    expect((await request(app).put('/grants').send({ ...input, permissions: ['annotate'] })).status).toBe(400);
    const foreign = await CrmUser.create({ organizationId: otherOrg, email: `recording-foreign-${stamp}@example.com`, fullName: 'Foreign', username: `recording-foreign-${stamp}`, role: 'admin', password: 'Password123!', isActive: true });
    try {
      expect((await request(app).put('/grants').send({ ...input, principalId: String(foreign._id) })).status).toBe(403);
      expect((await request(app).get('/settings').set('x-org', otherOrg)).status).toBe(403);
      expect((await request(app).get('/settings').set('x-org', otherOrg).set('x-user', String(foreign._id))).body.data.staff.some((u: any) => u.id === String(rep._id))).toBe(false);
    } finally { await CrmUser.deleteOne({ _id: foreign._id }); }
  });
  it('reports each person\'s own access for the menu', async () => {
    expect((await request(app).get('/access')).body.data).toEqual({ permissions: ['view', 'download', 'share', 'review', 'delete'], admin: true, principalId: String(boss._id) });
    expect((await request(app).get('/access').set('x-user', String(rep._id))).body.data).toEqual({ permissions: [], admin: false, principalId: String(rep._id) });
    expect((await request(app).get('/access').set('x-org', otherOrg)).status).toBe(403);
  });
  it('when automatic recording is turned off, nothing records by itself; the rep presses Record, hears the announcement, then recording starts', async () => {
    await CallRecordingSettings.create({ organizationId: org, announcementText: 'This call is now being recorded for quality.', retentionMonths: 3, autoRecord: false });
    const c = await call();
    await observeRecordingCall('call.bridged', { call_control_id: c.providerCallControlId, call_session_id: c.providerCallSessionId, connection_id: 'customer-connection' });
    expect(provider.recordingCommand).not.toHaveBeenCalled(); expect(await CallRecording.countDocuments({ callLogId: c._id })).toBe(0);
    const status = await request(app).get(`/calls/${c._id}`).set('x-user', String(rep._id));
    expect(status.status).toBe(200); expect(status.body.data).toMatchObject({ recording: null, canStart: true, canControl: true });
    const started = await request(app).post(`/calls/${c._id}/control`).set('x-user', String(rep._id)).send({ action: 'start' }); expect(started.status).toBe(200);
    let r: any = await CallRecording.findOne({ callLogId: c._id });
    expect(r.state).toBe('disclosing'); expect(r.employeeId).toBe(String(rep._id)); expect(r.startedBy).toBe(String(rep._id)); expect(r.policy).toMatchObject({ retentionMonths: 3, connectionId: 'customer-connection' });
    expect(provider.recordingDisclosure).toHaveBeenCalledWith(c.providerCallControlId, 'This call is now being recorded for quality.', 'en-US', expect.any(String), expect.any(String));
    expect(provider.recordingCommand).not.toHaveBeenCalled();
    expect(await finishRecordingDisclosure({ call_control_id: c.providerCallControlId, client_state: encode({ kind: 'ivr-menu' }) })).toBe(false);
    const done = { call_control_id: c.providerCallControlId, client_state: encode({ recordingDisclosureId: String(r._id) }), status: 'completed' };
    await finishRecordingDisclosure(done); await finishRecordingDisclosure(done);
    expect(provider.recordingCommand).toHaveBeenCalledTimes(1); expect(provider.recordingCommand).toHaveBeenCalledWith(c.providerCallControlId, 'start', expect.any(String));
    r = await CallRecording.findById(r._id); expect(r.state).toBe('recording');
    expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep._id))).body.data).toMatchObject({ canStart: false, canControl: true, recording: { state: 'recording' } });
    expect((await request(app).post(`/calls/${c._id}/control`).set('x-user', String(rep._id)).send({ action: 'start' })).status).toBe(409);
    expect(await CallRecordingAudit.countDocuments({ recordingId: r._id, action: 'recording.requested', actorId: String(rep._id) })).toBe(1);
  });
  it('only the rep on the call can record it, and only once the call is connected in the browser', async () => {
    const c = await call();
    expect((await request(app).post(`/calls/${c._id}/control`).set('x-user', String(rep2._id)).send({ action: 'start' })).status).toBe(403);
    expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep2._id))).status).toBe(403);
    expect((await request(app).get(`/calls/${c._id}`)).body.data).toMatchObject({ canStart: false, canControl: false });
    const connecting = await call('inbound', { recordingCorrelation: { verified: true, connectionId: 'customer-connection', answerControlId: 'agent-x', bridged: false } });
    const waiting = await request(app).post(`/calls/${connecting._id}/control`).set('x-user', String(rep._id)).send({ action: 'start' });
    expect(waiting.status).toBe(409); expect(waiting.body.message).toContain('still connecting');
    const ended = await call('inbound', { status: 'completed' });
    expect((await request(app).post(`/calls/${ended._id}/control`).set('x-user', String(rep._id)).send({ action: 'start' })).status).toBe(409);
    const onPhone = await call('inbound', { answeredVia: 'phone' });
    expect((await request(app).get(`/calls/${onPhone._id}`).set('x-user', String(rep._id))).body.data.canStart).toBe(false);
    expect((await request(app).post(`/calls/${onPhone._id}/control`).set('x-user', String(rep._id)).send({ action: 'start' })).status).toBe(409);
    expect((await request(app).post(`/calls/${c._id}/control`).set('x-user', String(rep._id)).send({ action: 'consent' })).status).toBe(400);
    expect(provider.recordingDisclosure).not.toHaveBeenCalled();
  });
  it('if the announcement cannot be played, nothing is recorded and the rep can press Record again', async () => {
    const c = await call(); (provider.recordingDisclosure as jest.Mock).mockRejectedValueOnce(new Error('provider down'));
    const failed = await request(app).post(`/calls/${c._id}/control`).set('x-user', String(rep._id)).send({ action: 'start' });
    expect(failed.status).toBe(502); expect(failed.body.message).toContain("couldn't start");
    expect((await CallRecording.findOne({ callLogId: c._id })).state).toBe('failed');
    expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep._id))).body.data.canStart).toBe(true);
    expect((await request(app).post(`/calls/${c._id}/control`).set('x-user', String(rep._id)).send({ action: 'start' })).status).toBe(200);
    expect(await CallRecording.countDocuments({ callLogId: c._id })).toBe(1); expect((await CallRecording.findOne({ callLogId: c._id })).state).toBe('disclosing');
    expect(provider.recordingCommand).not.toHaveBeenCalled();
  });
  it('inbound: the menu answer is not enough; the rep answering in the browser plus the bridge makes Record available', async () => {
    await CallRecordingSettings.create({ organizationId: org, autoRecord: false });
    const c = await call('inbound', { recordingCorrelation: {}, status: 'in-progress', routing: { revision: 3 } });
    const payload = { call_control_id: c.providerCallControlId, call_session_id: c.providerCallSessionId, connection_id: 'customer-connection', call_leg_id: 'customer-leg', client_state: encode({ kind: 'ivr-menu' }) };
    await observeRecordingCall('call.initiated', payload); await observeRecordingCall('call.answered', payload);
    expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep._id))).body.data.canStart).toBe(false);
    const agent = { ...payload, connection_id: 'sip-connection', call_control_id: c.agentLegCallControlId, call_leg_id: 'agent-leg', client_state: encode({ kind: 'agent-leg', callLogId: String(c._id), userId: String(rep._id), revision: 3 }) };
    await observeRecordingCall('call.answered', { ...agent, client_state: encode({ kind: 'agent-leg', callLogId: String(c._id), userId: String(rep._id), revision: 2 }) });
    expect((await CallLog.findById(c._id).select('+recordingCorrelation')).recordingCorrelation.verified).toBeFalsy();
    await observeRecordingCall('call.answered', agent); expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep._id))).body.data.canStart).toBe(false);
    await observeRecordingCall('call.bridged', agent); expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep._id))).body.data.canStart).toBe(true);
    expect(provider.recordingCommand).not.toHaveBeenCalled();
    const stored: any = await CallLog.findById(c._id).select('+recordingCorrelation');
    expect(stored.recordingCorrelation).toMatchObject({ connectionId: 'customer-connection', verified: true, bridged: true, customerLegId: 'customer-leg' });
    await observeRecordingCall('call.bridged', { ...payload, connection_id: 'another-connection' });
    expect((await CallLog.findById(c._id).select('+recordingCorrelation')).recordingCorrelation.connectionId).toBe('customer-connection');
    const r: any = await startRecording(c); expect(r.state).toBe('recording'); expect(r.controlId).toBe(c.providerCallControlId); expect(r.legId).toBe('customer-leg');
  });
  it('outbound browser calls need the signed call token and matching numbers; the first verified connection is kept', async () => {
    await CallRecordingSettings.create({ organizationId: org, autoRecord: false });
    const c = await call('outbound', { recordingCorrelation: {}, providerCallSessionId: undefined, providerCallControlId: undefined });
    expect((await request(app).post(`/calls/${c._id}/control`).set('x-user', String(rep._id)).send({ action: 'start' })).status).toBe(409);
    const correlation = await createOutboundCorrelation(c, await recordingPrincipal(String(rep._id), org));
    const payload = { client_state: encode({ kind: 'recording-outbound', ...correlation }), call_control_id: 'outbound-control', call_session_id: 'outbound-session', call_leg_id: 'outbound-leg', connection_id: 'browser-connection', to: c.to, from: c.from };
    await observeRecordingCall('call.answered', { ...payload, client_state: encode({ kind: 'recording-outbound', ...correlation, token: 'forged' }) });
    await observeRecordingCall('call.answered', { ...payload, from: '+18015550000' });
    expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep._id))).body.data.canStart).toBe(false);
    await observeRecordingCall('call.answered', payload);
    expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep._id))).body.data.canStart).toBe(true);
    await observeRecordingCall('call.answered', { ...payload, connection_id: 'other-connection' });
    const stored: any = await CallLog.findById(c._id).select('+recordingCorrelation');
    expect(stored.providerCallSessionId).toBe('outbound-session'); expect(stored.recordingCorrelation.connectionId).toBe('browser-connection');
    const r: any = await startRecording(c); expect(r.state).toBe('recording'); expect(r.controlId).toBe('outbound-control'); expect(r.direction).toBe('outbound');
  });
  it('records automatically by default: once the rep answers in the browser and the call is bridged, the announcement plays, then recording starts', async () => {
    const c = await call('inbound', { recordingCorrelation: {}, status: 'in-progress', routing: { revision: 3 } });
    const payload = { call_control_id: c.providerCallControlId, call_session_id: c.providerCallSessionId, connection_id: 'customer-connection', call_leg_id: 'customer-leg', client_state: encode({ kind: 'ivr-menu' }) };
    await observeRecordingCall('call.initiated', payload);
    const agent = { ...payload, connection_id: 'sip-connection', call_control_id: c.agentLegCallControlId, call_leg_id: 'agent-leg', client_state: encode({ kind: 'agent-leg', callLogId: String(c._id), userId: String(rep._id), revision: 3 }) };
    await observeRecordingCall('call.answered', agent);
    expect(provider.recordingDisclosure).not.toHaveBeenCalled();
    await observeRecordingCall('call.bridged', agent); await observeRecordingCall('call.bridged', agent);
    expect(provider.recordingDisclosure).toHaveBeenCalledTimes(1);
    expect(provider.recordingDisclosure).toHaveBeenCalledWith(c.providerCallControlId, DEFAULT_RECORDING_ANNOUNCEMENT, 'en-US', expect.any(String), expect.any(String));
    let r: any = await CallRecording.findOne({ callLogId: c._id });
    expect(r).toMatchObject({ state: 'disclosing', employeeId: String(rep._id), controlId: c.providerCallControlId, legId: 'customer-leg' });
    expect(provider.recordingCommand).not.toHaveBeenCalled();
    await finishRecordingDisclosure({ call_control_id: c.providerCallControlId, client_state: encode({ recordingDisclosureId: String(r._id) }), status: 'completed' });
    r = await CallRecording.findById(r._id); expect(r.state).toBe('recording');
    expect(provider.recordingCommand).toHaveBeenCalledWith(c.providerCallControlId, 'start', expect.any(String));
    expect(await CallRecordingAudit.countDocuments({ recordingId: r._id, action: 'recording.auto-requested', actorId: String(rep._id) })).toBe(1);
    expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep._id))).body.data).toMatchObject({ canStart: false, canControl: true, recording: { state: 'recording' } });
  });
  it('records outbound browser calls automatically once the verified call is answered', async () => {
    const c = await call('outbound', { recordingCorrelation: {}, providerCallSessionId: undefined, providerCallControlId: undefined });
    const correlation = await createOutboundCorrelation(c, await recordingPrincipal(String(rep._id), org));
    const payload = { client_state: encode({ kind: 'recording-outbound', ...correlation }), call_control_id: 'auto-outbound-control', call_session_id: 'auto-outbound-session', call_leg_id: 'auto-outbound-leg', connection_id: 'browser-connection', to: c.to, from: c.from };
    await observeRecordingCall('call.answered', { ...payload, client_state: encode({ kind: 'recording-outbound', ...correlation, token: 'forged' }) });
    expect(provider.recordingDisclosure).not.toHaveBeenCalled();
    await observeRecordingCall('call.answered', payload);
    expect(provider.recordingDisclosure).toHaveBeenCalledTimes(1);
    expect(provider.recordingDisclosure).toHaveBeenCalledWith('auto-outbound-control', DEFAULT_RECORDING_ANNOUNCEMENT, 'en-US', expect.any(String), expect.any(String));
    expect(await CallRecording.findOne({ callLogId: c._id })).toMatchObject({ direction: 'outbound', employeeId: String(rep._id), state: 'disclosing' });
  });
  it('does not record by itself when the call is not connected in the browser, or was taken on a phone', async () => {
    const phone = await call('inbound', { answeredVia: 'phone' });
    await observeRecordingCall('call.bridged', { call_control_id: phone.providerCallControlId, call_session_id: phone.providerCallSessionId, connection_id: 'customer-connection' });
    const connecting = await call('inbound', { recordingCorrelation: { verified: true, connectionId: 'customer-connection', answerControlId: 'agent-y', bridged: false }, status: 'answering' });
    await observeRecordingCall('call.answered', { call_control_id: connecting.providerCallControlId, call_session_id: connecting.providerCallSessionId, connection_id: 'customer-connection' });
    expect(provider.recordingDisclosure).not.toHaveBeenCalled();
    expect(await CallRecording.countDocuments({ callLogId: { $in: [phone._id, connecting._id] } })).toBe(0);
  });
  it('a voicemail is saved on the missed call, then the line hangs up; only admins and the people the call rang can listen', async () => {
    const c = await call('inbound', { status: 'missed', endedAt: new Date(), answeredBy: undefined, routing: { revision: 4, allOrg: false, notifiedIds: [String(rep2._id)] } });
    const started: any = await startVoicemailRecording(await CallLog.findById(c._id).select('+recordingCorrelation'));
    expect(started).toMatchObject({ kind: 'voicemail', state: 'recording', listenerIds: [String(rep2._id)], openToAllStaff: false, controlId: c.providerCallControlId });
    expect(provider.recordingCommand).toHaveBeenCalledWith(c.providerCallControlId, 'start', expect.stringMatching(/^voicemail-start-/), expect.objectContaining({ play_beep: true, max_length: 120 }));
    expect(provider.recordingDisclosure).not.toHaveBeenCalled();
    await enqueueRecordingEvent(`recording-test-${stamp}-voicemail`, 'call.recording.saved', { call_session_id: c.providerCallSessionId, call_leg_id: started.legId, connection_id: 'customer-connection', recording_id: `voicemail-${stamp}`, recording_started_at: new Date(started.startedAt.getTime() + 500).toISOString(), recording_ended_at: new Date(started.startedAt.getTime() + 30500).toISOString(), recording_urls: { mp3: 'https://bucket.s3.amazonaws.com/voicemail.mp3' } });
    await recoverRecordings();
    const saved: any = await CallRecording.findById(started._id);
    expect(saved.state).toBe('ready'); expect(saved.files).toHaveLength(1);
    expect(provider.hangupCall).toHaveBeenCalledWith(c.providerCallControlId);
    expect((await request(app).get(`/recordings/${started._id}`).set('x-user', String(rep2._id))).status).toBe(200);
    expect((await request(app).get(`/recordings/${started._id}`).set('x-user', String(rep._id))).status).toBe(403);
    expect((await request(app).get(`/recordings/${started._id}`).set('x-user', String(outsider._id))).status).toBe(403);
    expect((await request(app).get(`/recordings/${started._id}`)).status).toBe(200);
    expect((await request(app).post(`/recordings/${started._id}/media`).set('x-user', String(rep2._id)).send({ mode: 'download', fileId: String(saved.files[0]._id) })).status).toBe(403);
    expect((await request(app).get(`/calls/${c._id}`).set('x-user', String(rep2._id))).status).toBe(200);
  });
  it('a voicemail on a call that rang everyone can be heard by all staff; nothing starts without the customer leg details', async () => {
    const c = await call('inbound', { status: 'missed', endedAt: new Date(), answeredBy: undefined });
    const open: any = await startVoicemailRecording(await CallLog.findById(c._id).select('+recordingCorrelation'));
    expect(open).toMatchObject({ kind: 'voicemail', openToAllStaff: true, listenerIds: [] });
    await CallRecording.updateOne({ _id: open._id }, { $set: { state: 'ready', files: [{ _id: new mongoose.Types.ObjectId(), key: 'k', bytes: 1, startedAt: new Date(), endedAt: new Date() }] } });
    expect((await request(app).get(`/recordings/${open._id}`).set('x-user', String(rep._id))).status).toBe(200);
    const missing = await call('inbound', { status: 'missed', recordingCorrelation: {} });
    expect(await startVoicemailRecording(await CallLog.findById(missing._id).select('+recordingCorrelation'))).toBeNull();
    const live = await call('inbound');
    expect(await startVoicemailRecording(await CallLog.findById(live._id).select('+recordingCorrelation'))).toBeNull();
  });
  it('saves the call transcript and an AI summary on the recording, once, for people who can listen', async () => {
    const c = await call(); const r: any = await startRecording(c);
    const transcription = { call_session_id: c.providerCallSessionId, call_leg_id: r.legId, connection_id: 'customer-connection', recording_id: `rec-${stamp}`, recording_transcription_id: `tr-${stamp}`, status: 'completed', transcription_text: 'Hi, is the Tacoma still available? Yes, want to come Saturday?' };
    await enqueueRecordingEvent(`recording-test-${stamp}-transcript`, 'call.recording.transcription.saved', transcription);
    await enqueueRecordingEvent(`recording-test-${stamp}-transcript-again`, 'call.recording.transcription.saved', transcription);
    await recoverRecordings();
    const saved: any = await CallRecording.findById(r._id);
    expect(saved.transcriptParts).toHaveLength(1);
    expect(saved.state).toBe('recording'); expect(saved.incomplete).toBe(false);
    expect(callSummary.summarizeCallTranscript).toHaveBeenCalledWith('Hi, is the Tacoma still available? Yes, want to come Saturday?', false);
    const detail = await request(app).get(`/recordings/${r._id}`).set('x-user', String(rep._id));
    expect(detail.status).toBe(200);
    expect(detail.body.data.recording).toMatchObject({ transcript: 'Hi, is the Tacoma still available? Yes, want to come Saturday?', transcriptReady: true, summaryPoints: ['Customer asked if the Tacoma is still available.', 'Rep offered a test drive on Saturday.'], summarySentiment: 'Interested and friendly.', summaryError: '' });
    expect((await request(app).get(`/recordings/${r._id}`).set('x-user', String(rep2._id))).status).toBe(403);
  });
  it('a failed transcript is explained, silence gives no summary, and deleting the recording removes the transcript everywhere', async () => {
    const c = await call(); const r: any = await startRecording(c);
    await enqueueRecordingEvent(`recording-test-${stamp}-transcript-failed`, 'call.recording.transcription.saved', { call_session_id: c.providerCallSessionId, call_leg_id: r.legId, connection_id: 'customer-connection', recording_transcription_id: `trf-${stamp}`, status: 'failed' });
    await recoverRecordings();
    expect((await CallRecording.findById(r._id)).summaryError).toContain('could not be made');
    (callSummary.summarizeCallTranscript as jest.Mock).mockClear();
    await enqueueRecordingEvent(`recording-test-${stamp}-transcript-silent`, 'call.recording.transcription.saved', { call_session_id: c.providerCallSessionId, call_leg_id: r.legId, connection_id: 'customer-connection', recording_transcription_id: `trs-${stamp}`, status: 'completed', transcription_text: '' });
    await recoverRecordings();
    expect(callSummary.summarizeCallTranscript).not.toHaveBeenCalled();
    expect((await CallRecording.findById(r._id)).summaryError).toContain('No speech');
    await enqueueRecordingEvent(`recording-test-${stamp}-transcript-other`, 'call.recording.transcription.saved', { call_session_id: c.providerCallSessionId, call_leg_id: r.legId, connection_id: 'another-connection', recording_transcription_id: `tro-${stamp}`, status: 'completed', transcription_text: 'not ours' });
    await recoverRecordings();
    expect((await CallRecording.findById(r._id)).transcriptParts.map((part: any) => part.text)).not.toContain('not ours');
    const done: any = await finishCall(c, r, 'transcribed');
    expect((await request(app).delete(`/recordings/${done._id}`)).status).toBe(200);
    const gone: any = await CallRecording.findById(r._id).lean();
    expect(gone.state).toBe('deleted'); expect(gone.transcriptParts).toBeUndefined(); expect(gone.summaryError).toBeUndefined();
    expect(provider.deleteRecordingTranscription).toHaveBeenCalledWith(`trs-${stamp}`);
  });
  it('the rep on the call can pause and resume without any permission; pause stays until they resume', async () => {
    const c = await call(); await startRecording(c); const p = await recordingPrincipal(String(rep._id), org);
    expect(await CallRecordingGrant.countDocuments({ organizationId: org, principalId: String(rep._id) })).toBe(0);
    await controlRecording(p, String(c._id), 'pause');
    await observeRecordingCall('call.bridged', { call_control_id: c.providerCallControlId, call_session_id: c.providerCallSessionId, connection_id: 'customer-connection' });
    let r: any = await CallRecording.findOne({ callLogId: c._id }); expect(r.state).toBe('paused'); expect(r.manualPaused).toBe(true);
    expect(provider.recordingCommand).toHaveBeenLastCalledWith(c.providerCallControlId, 'pause', expect.any(String));
    expect((await request(app).post(`/calls/${c._id}/control`).set('x-user', String(rep._id)).send({ action: 'resume' })).status).toBe(200);
    r = await CallRecording.findOne({ callLogId: c._id }); expect(r.state).toBe('recording'); expect(r.manualPaused).toBe(false);
    await expect(controlRecording(await recordingPrincipal(String(boss._id), org), String(c._id), 'pause')).rejects.toThrow('Only the rep');
  });
  it('pause failure is unknown/incomplete, attempts stop, and never auto resumes', async () => {
    const c = await call(); await startRecording(c); (provider.recordingCommand as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
    await expect(controlRecording(await recordingPrincipal(String(rep._id), org), String(c._id), 'pause')).rejects.toThrow('unknown');
    const r: any = await CallRecording.findOne({ callLogId: c._id }); expect(r.state).toBe('unknown'); expect(r.manualPaused).toBe(true); expect(r.incomplete).toBe(true);
    expect((await CallLog.findById(c._id)).status).toBe('in-progress'); expect(provider.recordingCommand).toHaveBeenLastCalledWith(c.providerCallControlId, 'stop', expect.any(String));
  });
  it('provider start failure preserves the connected call', async () => {
    const c = await call(); (provider.recordingCommand as jest.Mock).mockRejectedValueOnce(new Error('provider unavailable'));
    await startRecording(c);
    expect((await CallRecording.findOne({ callLogId: c._id })).state).toBe('failed'); expect((await CallLog.findById(c._id)).status).toBe('in-progress');
  });
  it('resume failure stays manually paused and never changes the call status', async () => {
    const c = await call(); await startRecording(c); const p = await recordingPrincipal(String(rep._id), org); await controlRecording(p, String(c._id), 'pause');
    (provider.recordingCommand as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
    await expect(controlRecording(p, String(c._id), 'resume')).rejects.toThrow('unknown');
    expect((await CallRecording.findOne({ callLogId: c._id })).manualPaused).toBe(true); expect((await CallLog.findById(c._id)).status).toBe('in-progress');
  });
  it('blocks every recording action for people without access and for other dealerships', async () => {
    const c = await call(); const r: any = await startRecording(c);
    const requests = [() => request(app).get(`/recordings/${r._id}`), () => request(app).get('/recordings'), () => request(app).post(`/recordings/${r._id}/media`).send({ mode: 'play', fileId: String(new mongoose.Types.ObjectId()) }), () => request(app).post(`/recordings/${r._id}/media`).send({ mode: 'download', fileId: String(new mongoose.Types.ObjectId()) }), () => request(app).post(`/recordings/${r._id}/shares`), () => request(app).post(`/recordings/${r._id}/review`), () => request(app).delete(`/recordings/${r._id}`)];
    for (const make of requests) expect((await make().set('x-user', String(outsider._id))).status).toBe(403);
    for (const make of requests) expect((await make().set('x-user', String(rep2._id))).status).toBe(403);
    for (const make of requests) expect((await make().set('x-org', otherOrg)).status).toBe(403);
    expect((await requests[0]().set('x-user', String(rep._id))).status).toBe(200);
    expect((await requests[2]().set('x-user', String(rep._id))).status).not.toBe(403);
    for (const make of [requests[1], requests[3], requests[4], requests[5], requests[6]]) expect((await make().set('x-user', String(rep._id))).status).toBe(403);
  });
  it('admins have every recording permission without a grant; other staff still need a grant', async () => {
    const admin2 = await CrmUser.create({ organizationId: org, email: `recording-admin2-${stamp}@example.com`, fullName: 'Second Admin', username: `recording-admin2-${stamp}`, role: 'admin', password: 'Password123!', isActive: true });
    try {
      const p = await recordingPrincipal(String(admin2._id), org);
      expect(await CallRecordingGrant.countDocuments({ organizationId: org, principalId: String(admin2._id) })).toBe(0);
      for (const permission of ['view', 'download', 'share', 'review', 'delete'] as const) await expect(requireRecordingPermission(p, permission)).resolves.toBeUndefined();
      await expect(requireRecordingPermission(p, 'control')).rejects.toThrow('permission');
      await expect(requireRecordingPermission(await recordingPrincipal(String(rep2._id), org), 'view')).rejects.toThrow('permission');
    } finally { await CrmUser.deleteOne({ _id: admin2._id }); }
  });
  it('rejects synthetic admin elevation and foreign org staff', async () => {
    expect((await request(app).get('/settings').set('x-user', String(outsider._id))).status).toBe(403);
    await expect(recordingPrincipal(String(rep._id), otherOrg)).rejects.toThrow();
  });
  it('lists recorded calls with customer, rep, call length and date; review marks who and when; filters work', async () => {
    const lead = await Lead.create({ organizationId: org, createdBy: boss._id, firstName: 'Jordan', lastName: 'Listcaller', phone: '+18015550177', status: 'New', channel: 'phone', source: 'Inbound Call' });
    const answeredAt = new Date(Date.now() - 200000);
    const first = await call('inbound', { from: '+18015550177', leadId: lead._id, lineLabel: 'Test Line', answeredAt });
    const firstRecording: any = await startRecording(first);
    await CallLog.updateOne({ _id: first._id }, { $set: { durationSec: 125 } });
    const second = await call('inbound', { from: '+18015550178', answeredBy: { userId: rep2._id, name: 'Second Rep' }, placedBy: { userId: rep2._id } });
    const secondRecording: any = await startRecording(second, rep2);
    const notStarted = await call(); (provider.recordingDisclosure as jest.Mock).mockRejectedValueOnce(new Error('down'));
    await expect(startManualRecording(await recordingPrincipal(String(rep._id), org), String(notStarted._id))).rejects.toThrow();
    const gone = await call(); const goneRecording: any = await startRecording(gone); await CallRecording.updateOne({ _id: goneRecording._id }, { $set: { state: 'deleted' } });
    const old = await call(); const oldRecording: any = await startRecording(old); await CallRecording.updateOne({ _id: oldRecording._id }, { $set: { startedAt: new Date('2025-01-15T18:00:00Z') } });
    const list = await request(app).get('/recordings');
    expect(list.status).toBe(200);
    const ids = list.body.data.items.map((item: any) => String(item._id));
    expect(ids).toEqual(expect.arrayContaining([String(firstRecording._id), String(secondRecording._id), String(oldRecording._id)]));
    expect(ids).not.toContain(String(goneRecording._id));
    expect(await CallRecording.countDocuments({ callLogId: notStarted._id, startedAt: null })).toBe(1);
    const row = list.body.data.items.find((item: any) => String(item._id) === String(firstRecording._id));
    expect(row).toMatchObject({ customerName: 'Jordan Listcaller', customerPhone: '+18015550177', leadId: String(lead._id), repName: 'Recording Rep', direction: 'inbound', line: 'Test Line', durationSec: 125, state: 'recording', reviewedAt: null });
    expect(list.body.data.items.find((item: any) => String(item._id) === String(secondRecording._id))).toMatchObject({ customerName: '', customerPhone: '+18015550178', repName: 'Second Rep' });
    expect(list.body.data.reps.map((r: any) => r.name)).toEqual(expect.arrayContaining(['Recording Rep', 'Second Rep']));
    const reviewed = await request(app).post(`/recordings/${firstRecording._id}/review`); expect(reviewed.status).toBe(200); expect(reviewed.body.data.reviewedByName).toBe('Recording Admin');
    const after: any = await CallRecording.findById(firstRecording._id); expect(after.reviewedBy).toBe(String(boss._id)); expect(after.reviewedAt).toBeInstanceOf(Date);
    expect((await request(app).get(`/recordings/${firstRecording._id}`)).body.data.recording).toMatchObject({ reviewedByName: 'Recording Admin' });
    const only = async (query: string) => (await request(app).get(`/recordings?${query}`)).body.data.items.map((item: any) => String(item._id));
    expect(await only('reviewed=reviewed')).toEqual([String(firstRecording._id)]);
    expect(await only('reviewed=unreviewed')).not.toContain(String(firstRecording._id));
    expect(await only(`repId=${rep2._id}`)).toEqual([String(secondRecording._id)]);
    expect(await only('search=listcaller')).toEqual([String(firstRecording._id)]);
    expect(await only('search=jordan%20list')).toEqual([String(firstRecording._id)]);
    expect(await only('search=801-555-0178')).toEqual([String(secondRecording._id)]);
    expect(await only(`from=${encodeURIComponent('2025-01-01T07:00:00.000Z')}&to=${encodeURIComponent('2025-02-01T06:59:59.999Z')}`)).toEqual([String(oldRecording._id)]);
    expect((await request(app).get('/recordings?from=yesterday')).status).toBe(400);
    expect((await request(app).get('/recordings').set('x-org', otherOrg).set('x-user', String(boss._id))).status).toBe(403);
    const page2 = await request(app).get('/recordings?page=2'); expect(page2.body.data).toMatchObject({ page: 2, pageSize: 25 }); expect(page2.body.data.items).toEqual([]);
  });
  it('reconciles a missing saved webhook using provider recording identity', async () => {
    const c = await call(); let r: any = await startRecording(c);
    const ended = new Date(); await CallLog.updateOne({ _id: c._id }, { $set: { status: 'completed', endedAt: ended } });
    await observeRecordingCall('call.hangup', { call_session_id: c.providerCallSessionId, call_control_id: c.providerCallControlId, connection_id: 'customer-connection' });
    (provider.findRecordings as jest.Mock).mockResolvedValue([{ id: `recording-test-${stamp}-recovered`, call_leg_id: r.legId, recording_started_at: r.startedAt.toISOString(), recording_ended_at: ended.toISOString(), download_urls: { mp3: 'https://bucket.s3.amazonaws.com/fixture.mp3' } }]);
    await recoverRecordings(); await recoverRecordings(); r = await CallRecording.findById(r._id); expect(r.state).toBe('ready'); expect(r.files).toHaveLength(1);
    expect(r.expiresAt.getTime()).toBeGreaterThan(Date.now() + 150 * 86400000);
    await CallRecording.updateOne({ _id: r._id }, { $set: { state: 'deleted' } });
  });
  it('records failed-upload keys for cleanup and permits authorized import recovery', async () => {
    const c = await call(); let r: any = await startRecording(c);
    const ended = new Date(); await CallLog.updateOne({ _id: c._id }, { $set: { status: 'completed', endedAt: ended } });
    await observeRecordingCall('call.hangup', { call_session_id: c.providerCallSessionId, call_control_id: c.providerCallControlId, connection_id: 'customer-connection' });
    (storage.importRecordingFile as jest.Mock).mockRejectedValueOnce(new Error('R2 upload verification failed'));
    await enqueueRecordingEvent(`recording-test-${stamp}-failed-upload`, 'call.recording.saved', { call_session_id: c.providerCallSessionId, call_leg_id: r.legId, connection_id: 'customer-connection', recording_id: `failed-upload-${stamp}`, recording_started_at: r.startedAt.toISOString(), recording_ended_at: ended.toISOString(), recording_urls: { mp3: 'https://bucket.s3.amazonaws.com/file.mp3' } });
    await recoverRecordings(); r = await CallRecording.findById(r._id); expect(r.pendingFiles).toHaveLength(1); expect(r.incomplete).toBe(true);
    expect((await request(app).post(`/recordings/${r._id}/retry`).set('x-user', String(rep._id))).status).toBe(403);
    expect((await request(app).post(`/recordings/${r._id}/retry`)).status).toBe(200);
    expect((await request(app).delete(`/recordings/${r._id}`)).status).toBe(200);
    expect(storage.deleteRecordingFile).toHaveBeenCalledWith(r.pendingFiles[0].key); expect(provider.deleteProviderRecording).toHaveBeenCalledWith(`failed-upload-${stamp}`);
  });
  it('imports once into private storage, serves authorized media, shares require permission and revoke immediately', async () => {
    const c = await call(); let r: any = await startRecording(c);
    r = await finishCall(c, r, 'saved');
    await enqueueRecordingEvent(`recording-test-${stamp}-saved`, 'call.recording.saved', {}); await recoverRecordings();
    expect(r.files).toHaveLength(1); expect(r.state).toBe('ready'); expect(storage.importRecordingFile).toHaveBeenCalledTimes(1);
    const detail = await request(app).get(`/recordings/${r._id}`); expect(detail.status).toBe(200); expect(JSON.stringify(detail.body)).not.toContain('s3.amazonaws'); expect(detail.body.data.recording.files[0].key).toBeUndefined();
    expect((await request(app).get(`/recordings/${r._id}`).set('x-user', String(rep2._id))).status).toBe(403);
    expect((await request(app).get(`/recordings/${r._id}`).set('x-user', String(rep._id))).status).toBe(200);
    const share = await request(app).post(`/recordings/${r._id}/shares`); const shareId = share.body.data.shareId;
    expect((await request(app).get(`/shares/${shareId}`).set('x-user', String(rep2._id))).status).toBe(403);
    const authCookie = `crm_token=${await issueCrmSessionToken(String(boss._id))}`;
    const session = await request(app).post(`/recordings/${r._id}/media`).set('Cookie', authCookie).send({ mode: 'play', fileId: String(r.files[0]._id), shareId }); expect(session.status).toBe(200);
    const cookie = [authCookie, ...session.headers['set-cookie'].map((value: string) => value.split(';')[0])]; expect((await request(app).get(session.body.data.path).set('Cookie', cookie)).status).toBe(200);
    await request(app).delete(`/shares/${shareId}`); expect((await request(app).get(session.body.data.path).set('Cookie', cookie)).status).toBe(404);
    expect(await CallRecordingAudit.countDocuments({ recordingId: r._id, action: 'playback.accessed' })).toBe(1);
    await request(app).post(`/recordings/${r._id}/review`); expect(await CallRecordingAudit.countDocuments({ recordingId: r._id, action: 'recording.reviewed' })).toBe(1);
    await CallRecordingGrant.create({ organizationId: org, principalId: String(rep2._id), principalKind: 'crm', permissions: ['view', 'download'] });
    const rep2Cookie = `crm_token=${await issueCrmSessionToken(String(rep2._id))}`;
    const download = await request(app).post(`/recordings/${r._id}/media`).set('Cookie', rep2Cookie).send({ mode: 'download', fileId: String(r.files[0]._id) });
    const downloadCookies = [rep2Cookie, ...download.headers['set-cookie'].map((value: string) => value.split(';')[0])];
    const downloaded = await request(app).get(download.body.data.path).set('Cookie', downloadCookies); expect(downloaded.headers['content-disposition']).toContain('attachment');
    expect((await request(app).get(download.body.data.path)).status).toBe(401);
    await CallRecordingGrant.updateOne({ principalId: String(rep2._id), organizationId: org }, { $pull: { permissions: 'download' } });
    expect((await request(app).get(download.body.data.path).set('Cookie', downloadCookies)).status).toBe(403);
    await CallRecordingGrant.deleteOne({ principalId: String(rep2._id), organizationId: org });
    await CallRecording.updateOne({ _id: r._id }, { $set: { expiresAt: new Date(Date.now() - 1) } }); await recoverRecordings();
    expect(storage.deleteRecordingFile).toHaveBeenCalled(); expect(provider.deleteProviderRecording).toHaveBeenCalledWith(`saved-${stamp}`); expect((await CallRecording.findById(r._id)).state).toBe('deleted');
  });
});
