import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Readable } from 'stream';
jest.mock('../src/config', () => ({ __esModule: true, default: { bcryptSaltRounds: 4, jwt: { accessSecret: 'local-recording-access', refreshSecret: 'local-recording-refresh', accessExpiration: '15m', refreshExpiration: '7d' } } }));
jest.mock('../src/services/telnyx.service', () => ({ recordingCommand: jest.fn().mockResolvedValue({}), recordingDisclosure: jest.fn().mockResolvedValue({}), findRecordings: jest.fn().mockResolvedValue([]), deleteProviderRecording: jest.fn().mockResolvedValue({}) }));
jest.mock('../src/services/callRecordingStorage.service', () => ({ importRecordingFile: jest.fn().mockResolvedValue({ bytes: 8, checksum: 'test' }), deleteRecordingFile: jest.fn().mockResolvedValue(undefined), streamRecordingFile: jest.fn(async () => ({ stream: Readable.from(Buffer.from('test-mp3')), length: 8, type: 'audio/mpeg' })) }));
import CrmUser from '../src/models/CrmUser.model';
import User from '../src/models/User.model';
import { CallLog } from '../src/models/communication.model';
import { CallRecording, CallRecordingPolicy, CallRecordingGrant, CallRecordingAudit, CallRecordingEvent, CallRecordingShare, CallRecordingMediaSession } from '../src/models/CallRecording.model';
import { recordingPrincipal, requireRecordingPermission } from '../src/services/callRecordingAccess.service';
import { maybeStartRecording, observeRecordingCall, createOutboundCorrelation, controlRecording, finishRecordingDisclosure, enqueueRecordingEvent, recoverRecordings } from '../src/services/callRecording.service';
import * as provider from '../src/services/telnyx.service';
import * as storage from '../src/services/callRecordingStorage.service';
import * as ctrl from '../src/controllers/callRecording.controller';
import crmAuth, { issueCrmSessionToken } from '../src/middleware/crmAuth.middleware';
import Session from '../src/models/Session.model';
let org: string; let otherOrg: string; let rep: any; let boss: any; let outsider: any; let serial = 0;
const stamp = Date.now();
const encode = (tag: any) => Buffer.from(JSON.stringify(tag)).toString('base64');
const app = express(); app.use(express.json()); app.use(cookieParser());
app.use((req, _res, next) => { req.orgId = req.header('x-org') || org; req.crmUser = { _id: req.header('x-user') || boss?._id, role: 'admin' } as any; next(); });
app.get('/settings', ctrl.getSettings); app.post('/settings', ctrl.savePolicy); app.put('/grants', ctrl.saveGrant);
app.get('/calls/:id', ctrl.getCallRecording); app.get('/recordings/:id', ctrl.getRecording);
app.post('/calls/:id/control', ctrl.control);
app.post('/recordings/:id/media', (req, res, next) => req.cookies?.crm_token ? crmAuth()(req, res, next) : next(), ctrl.createMediaSession); app.get('/api/crm/communications/recordings/media/:id', ctrl.mediaSession);
app.post('/recordings/:id/shares', ctrl.createShare); app.get('/shares/:id', ctrl.resolveShare); app.delete('/shares/:id', ctrl.revokeShare);
app.post('/recordings/:id/review', ctrl.reviewRecording);
app.post('/recordings/:id/retry', ctrl.retryImport);
app.delete('/recordings/:id', ctrl.removeRecording);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ message: err.message }));
async function policy(direction = 'inbound', values: any = {}) {
  return CallRecordingPolicy.create({ organizationId: org, name: 'Fixture', number: '+18015550999', direction, enabled: true, connectionId: 'customer-connection', legalApproved: true, providerVerified: true, disclosureOwner: 'provider', providerDisclosureVerified: true, consentMode: 'notice', ...values });
}
async function call(direction = 'inbound', values: any = {}) {
  const i = ++serial;
  return CallLog.create({ orgId: org, direction, from: direction === 'inbound' ? '+18015550123' : '+18015550999', to: direction === 'inbound' ? '+18015550999' : '+18015550123', status: 'in-progress', providerCallControlId: `customer-${stamp}-${i}`, providerCallSessionId: `session-${stamp}-${i}`, agentLegCallControlId: `agent-${stamp}-${i}`, placedBy: { userId: rep._id }, answeredBy: direction === 'inbound' ? { userId: rep._id } : undefined, recordingCorrelation: { verified: true, connectionId: 'customer-connection', answerControlId: direction === 'inbound' ? `agent-${stamp}-${i}` : `customer-${stamp}-${i}`, bridged: true, customerLegId: `customer-leg-${i}`, legId: `customer-leg-${i}` }, ...values });
}
beforeAll(async () => {
  org = String(new mongoose.Types.ObjectId()); otherOrg = String(new mongoose.Types.ObjectId());
  await Promise.all([CallRecording.init(), CallRecordingPolicy.init(), CallRecordingEvent.init(), CallRecordingGrant.init()]);
  rep = await CrmUser.create({ organizationId: org, email: `recording-rep-${stamp}@example.com`, fullName: 'Recording Rep', username: `recording-rep-${stamp}`, role: 'employee', department: 'Sales', password: 'Password123!', isActive: true });
  boss = await CrmUser.create({ organizationId: org, email: `recording-admin-${stamp}@example.com`, fullName: 'Recording Admin', username: `recording-admin-${stamp}`, role: 'admin', password: 'Password123!', isActive: true });
  outsider = await User.create({ organizationId: org, email: `recording-outsider-${stamp}@example.com`, name: 'Employee', role: 'employee', personalInfo: { department: 'QA' }, password: 'Password123!', isActive: true });
  await CallRecordingGrant.create({ organizationId: org, principalId: String(rep._id), principalKind: 'crm', permissions: ['control'] });
  await CallRecordingGrant.create({ organizationId: org, principalId: String(boss._id), principalKind: 'crm', permissions: ['view', 'download', 'share', 'review', 'delete'] });
});
beforeEach(async () => { jest.clearAllMocks(); await CallRecordingPolicy.deleteMany({ organizationId: org }); (provider.recordingCommand as jest.Mock).mockResolvedValue({}); (provider.findRecordings as jest.Mock).mockResolvedValue([]); });
afterAll(async () => {
  const recordings: any[] = await CallRecording.find({ organizationId: org });
  await CallRecordingEvent.deleteMany({ eventId: { $regex: `^recording-test-${stamp}` } });
  for (const model of [CallRecording, CallRecordingPolicy, CallRecordingGrant, CallRecordingAudit, CallRecordingShare, CallRecordingMediaSession]) await model.deleteMany({ organizationId: org });
  await CallLog.deleteMany({ orgId: org }); await CrmUser.deleteMany({ _id: { $in: [rep._id, boss._id] } }); await User.deleteOne({ _id: outsider._id });
  await Session.deleteMany({ crmUserId: { $in: [rep._id, boss._id] } });
  expect(recordings.length).toBeGreaterThan(0);
  await mongoose.disconnect();
});
describe('Private recording lifecycle on local MongoDB', () => {
  it('returns real staff metadata and preserves explicitly granted linked main identities', async () => {
    const linked = await User.create({ organizationId: org, email: boss.email, name: 'Linked Admin', role: 'admin', password: 'Password123!', isActive: true });
    try {
      let response = await request(app).get('/settings'); expect(response.status).toBe(200);
      expect(response.body.data.staff.find((u: any) => u.id === String(rep._id))).toMatchObject({ kind: 'crm', role: 'employee', department: 'Sales' });
      expect(response.body.data.staff.find((u: any) => u.id === String(outsider._id))).toMatchObject({ kind: 'main', role: 'employee', department: 'QA' });
      expect(response.body.data.staff.some((u: any) => u.id === String(linked._id))).toBe(false);
      await CallRecordingGrant.create({ organizationId: org, principalId: String(linked._id), principalKind: 'main', permissions: ['view'] });
      response = await request(app).get('/settings');
      expect(response.body.data.staff.find((u: any) => u.id === String(linked._id))).toMatchObject({ kind: 'main', role: 'admin', email: boss.email });
      expect(response.body.data.staff.some((u: any) => u.id === String(boss._id) && u.kind === 'crm')).toBe(true);
    } finally { await User.deleteOne({ _id: linked._id }); await CallRecordingGrant.deleteOne({ organizationId: org, principalId: String(linked._id) }); }
  });
  it('saves a full permission set in one audited update and revokes through an empty set', async () => {
    const input = { principalId: String(outsider._id), principalKind: 'main', permissions: ['view', 'review', 'download', 'share', 'control', 'delete'] };
    const before = await CallRecordingAudit.countDocuments({ organizationId: org, action: 'permission.changed' });
    try {
      expect((await request(app).put('/grants').send(input)).status).toBe(200);
      expect((await CallRecordingGrant.findOne({ organizationId: org, principalId: input.principalId })).permissions).toEqual(input.permissions);
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
  it('blocks all six recording API capabilities for ungranted staff and foreign organizations', async () => {
    await policy(); const c = await call(); await maybeStartRecording(String(c._id));
    const r: any = await CallRecording.findOne({ callLogId: c._id });
    const requests = [() => request(app).get(`/recordings/${r._id}`), () => request(app).post(`/recordings/${r._id}/media`).send({ mode: 'play', fileId: String(new mongoose.Types.ObjectId()) }), () => request(app).post(`/recordings/${r._id}/media`).send({ mode: 'download', fileId: String(new mongoose.Types.ObjectId()) }), () => request(app).post(`/recordings/${r._id}/shares`), () => request(app).post(`/recordings/${r._id}/review`), () => request(app).post(`/calls/${c._id}/control`).send({ action: 'pause' }), () => request(app).delete(`/recordings/${r._id}`)];
    for (const make of requests) expect((await make().set('x-user', String(outsider._id))).status).toBe(403);
    for (const make of requests) expect((await make().set('x-org', otherOrg)).status).toBe(403);
  });
  it('requires explicit permissions, even for a real admin', async () => {
    const p = await recordingPrincipal(String(boss._id), org);
    await expect(requireRecordingPermission(p, 'control')).rejects.toThrow('permission');
    await expect(requireRecordingPermission(p, 'view')).resolves.toBeUndefined();
  });
  it('rejects synthetic admin elevation and foreign org staff', async () => {
    expect((await request(app).get('/settings').set('x-user', String(outsider._id))).status).toBe(403);
    await expect(recordingPrincipal(String(rep._id), otherOrg)).rejects.toThrow();
  });
  it('starts only after connected employee evidence; disabled/missing policies stay silent', async () => {
    const c = await call(); await maybeStartRecording(String(c._id)); expect(provider.recordingCommand).not.toHaveBeenCalled();
    await policy('inbound', { enabled: false }); await maybeStartRecording(String(c._id)); expect(provider.recordingCommand).not.toHaveBeenCalled();
    await CallRecordingPolicy.updateOne({ organizationId: org }, { $set: { enabled: true } });
    await maybeStartRecording(String(c._id)); await maybeStartRecording(String(c._id));
    expect(provider.recordingCommand).toHaveBeenCalledTimes(1); expect((await CallRecording.findOne({ callLogId: c._id })).state).toBe('recording');
  });
  it('inbound IVR answer does not record; employee answer plus bridge does', async () => {
    await policy(); const c = await call('inbound', { recordingCorrelation: {}, status: 'in-progress', routing: { revision: 3 } });
    const payload = { call_control_id: c.providerCallControlId, call_session_id: c.providerCallSessionId, connection_id: 'customer-connection', call_leg_id: 'customer-leg', client_state: encode({ kind: 'ivr-menu' }) };
    await observeRecordingCall('call.initiated', payload); await observeRecordingCall('call.answered', payload);
    expect(provider.recordingCommand).not.toHaveBeenCalled();
    const agent = { ...payload, connection_id: 'sip-connection', call_control_id: c.agentLegCallControlId, call_leg_id: 'agent-leg', client_state: encode({ kind: 'agent-leg', callLogId: String(c._id), userId: String(rep._id), revision: 3 }) };
    await observeRecordingCall('call.answered', agent); expect(provider.recordingCommand).not.toHaveBeenCalled();
    await observeRecordingCall('call.bridged', agent); expect(provider.recordingCommand).toHaveBeenCalledTimes(1);
  });
  it('outbound browser active is insufficient; signed nonce/connection/phone correlation is required', async () => {
    await policy('outbound'); const c = await call('outbound', { recordingCorrelation: {}, providerCallSessionId: undefined, providerCallControlId: undefined });
    await maybeStartRecording(String(c._id)); expect(provider.recordingCommand).not.toHaveBeenCalled();
    const correlation = await createOutboundCorrelation(c, await recordingPrincipal(String(rep._id), org));
    const payload = { client_state: encode({ kind: 'recording-outbound', ...correlation }), call_control_id: 'outbound-control', call_session_id: 'outbound-session', call_leg_id: 'outbound-leg', connection_id: 'customer-connection', to: c.to, from: c.from };
    await observeRecordingCall('call.answered', { ...payload, connection_id: 'wrong' }); expect(provider.recordingCommand).not.toHaveBeenCalled();
    await observeRecordingCall('call.answered', payload); expect(provider.recordingCommand).toHaveBeenCalledTimes(1);
    expect((await CallLog.findById(c._id)).providerCallSessionId).toBe('outbound-session');
  });
  it('Suprah notice finishes exactly once before recording and ignores unrelated speech', async () => {
    await policy('inbound', { disclosureOwner: 'suprah', disclosureText: 'Approved notice' }); const c = await call();
    await maybeStartRecording(String(c._id)); const r: any = await CallRecording.findOne({ callLogId: c._id });
    expect(provider.recordingDisclosure).toHaveBeenCalledTimes(1); expect(provider.recordingCommand).not.toHaveBeenCalled();
    expect(await finishRecordingDisclosure({ call_control_id: c.providerCallControlId })).toBe(false);
    const payload = { call_control_id: c.providerCallControlId, client_state: encode({ recordingDisclosureId: String(r._id) }), status: 'completed' };
    await finishRecordingDisclosure(payload); await finishRecordingDisclosure(payload); expect(provider.recordingCommand).toHaveBeenCalledTimes(1);
  });
  it('staff consent is required before start when configured', async () => {
    await policy('inbound', { consentMode: 'staff-confirmed' }); const c = await call(); await maybeStartRecording(String(c._id));
    expect(provider.recordingCommand).not.toHaveBeenCalled(); await controlRecording(await recordingPrincipal(String(rep._id), org), String(c._id), 'consent');
    expect(provider.recordingCommand).toHaveBeenCalledTimes(1);
  });
  it('pause is actual provider control and remains paused across later call events', async () => {
    await policy(); const c = await call(); await maybeStartRecording(String(c._id)); const p = await recordingPrincipal(String(rep._id), org);
    await controlRecording(p, String(c._id), 'pause'); await maybeStartRecording(String(c._id));
    let r: any = await CallRecording.findOne({ callLogId: c._id }); expect(r.state).toBe('paused'); expect(r.manualPaused).toBe(true);
    expect(provider.recordingCommand).toHaveBeenLastCalledWith(c.providerCallControlId, 'pause', expect.any(String));
    await controlRecording(p, String(c._id), 'resume'); r = await CallRecording.findOne({ callLogId: c._id }); expect(r.state).toBe('recording'); expect(r.manualPaused).toBe(false);
  });
  it('pause failure is unknown/incomplete, attempts stop, and never auto resumes', async () => {
    await policy(); const c = await call(); await maybeStartRecording(String(c._id)); (provider.recordingCommand as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
    await expect(controlRecording(await recordingPrincipal(String(rep._id), org), String(c._id), 'pause')).rejects.toThrow('unknown');
    const r: any = await CallRecording.findOne({ callLogId: c._id }); expect(r.state).toBe('unknown'); expect(r.manualPaused).toBe(true); expect(r.incomplete).toBe(true);
    expect((await CallLog.findById(c._id)).status).toBe('in-progress'); expect(provider.recordingCommand).toHaveBeenLastCalledWith(c.providerCallControlId, 'stop', expect.any(String));
  });
  it('provider start failure preserves the connected call', async () => {
    await policy(); const c = await call(); (provider.recordingCommand as jest.Mock).mockRejectedValueOnce(new Error('provider unavailable')); await maybeStartRecording(String(c._id));
    expect((await CallRecording.findOne({ callLogId: c._id })).state).toBe('failed'); expect((await CallLog.findById(c._id)).status).toBe('in-progress');
  });
  it('cannot control a different employee call or resume after policy disable', async () => {
    await policy(); const c = await call(); await maybeStartRecording(String(c._id));
    await expect(controlRecording(await recordingPrincipal(String(boss._id), org), String(c._id), 'pause')).rejects.toThrow();
    const p = await recordingPrincipal(String(rep._id), org); await controlRecording(p, String(c._id), 'pause');
    await CallRecordingPolicy.updateOne({ organizationId: org }, { $set: { enabled: false } });
    await expect(controlRecording(p, String(c._id), 'resume')).rejects.toThrow('disabled');
    expect((await CallRecording.findOne({ callLogId: c._id })).manualPaused).toBe(true);
  });
  it('resume failure stays manually paused and never changes the call status', async () => {
    await policy(); const c = await call(); await maybeStartRecording(String(c._id)); const p = await recordingPrincipal(String(rep._id), org); await controlRecording(p, String(c._id), 'pause');
    (provider.recordingCommand as jest.Mock).mockRejectedValueOnce(new Error('timeout'));
    await expect(controlRecording(p, String(c._id), 'resume')).rejects.toThrow('unknown');
    expect((await CallRecording.findOne({ callLogId: c._id })).manualPaused).toBe(true); expect((await CallLog.findById(c._id)).status).toBe('in-progress');
  });
  it('reconciles a missing saved webhook using provider recording identity', async () => {
    await policy(); const c = await call(); await maybeStartRecording(String(c._id)); let r: any = await CallRecording.findOne({ callLogId: c._id });
    const ended = new Date(); await CallLog.updateOne({ _id: c._id }, { $set: { status: 'completed', endedAt: ended } });
    await observeRecordingCall('call.hangup', { call_session_id: c.providerCallSessionId, call_control_id: c.providerCallControlId, connection_id: 'customer-connection' });
    (provider.findRecordings as jest.Mock).mockResolvedValue([{ id: `recording-test-${stamp}-recovered`, call_leg_id: r.legId, recording_started_at: r.startedAt.toISOString(), recording_ended_at: ended.toISOString(), download_urls: { mp3: 'https://bucket.s3.amazonaws.com/fixture.mp3' } }]);
    await recoverRecordings(); await recoverRecordings(); r = await CallRecording.findById(r._id); expect(r.state).toBe('ready'); expect(r.files).toHaveLength(1);
    await CallRecordingEvent.deleteMany({ eventId: `reconcile-recording-test-${stamp}-recovered` });
    await CallRecording.updateOne({ _id: r._id }, { $set: { state: 'deleted' } });
  });
  it('records failed-upload keys for cleanup and permits authorized import recovery', async () => {
    await policy(); const c = await call(); await maybeStartRecording(String(c._id)); let r: any = await CallRecording.findOne({ callLogId: c._id });
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
    await policy(); const c = await call(); await maybeStartRecording(String(c._id)); let r: any = await CallRecording.findOne({ callLogId: c._id });
    const end = new Date(); await CallLog.updateOne({ _id: c._id }, { $set: { status: 'completed', endedAt: end } });
    await observeRecordingCall('call.hangup', { call_session_id: c.providerCallSessionId, call_control_id: c.providerCallControlId, connection_id: 'customer-connection' });
    const payload = { call_session_id: c.providerCallSessionId, call_leg_id: r.legId, connection_id: 'customer-connection', recording_id: `provider-${stamp}`, recording_started_at: r.startedAt.toISOString(), recording_ended_at: end.toISOString(), recording_urls: { mp3: 'https://bucket.s3.amazonaws.com/file.mp3' } };
    await enqueueRecordingEvent(`recording-test-${stamp}-saved`, 'call.recording.saved', payload); await enqueueRecordingEvent(`recording-test-${stamp}-saved`, 'call.recording.saved', payload); await recoverRecordings();
    r = await CallRecording.findById(r._id); expect(r.files).toHaveLength(1); expect(r.state).toBe('ready'); expect(storage.importRecordingFile).toHaveBeenCalledTimes(1);
    const detail = await request(app).get(`/recordings/${r._id}`); expect(detail.status).toBe(200); expect(JSON.stringify(detail.body)).not.toContain('s3.amazonaws'); expect(detail.body.data.recording.files[0].key).toBeUndefined();
    expect((await request(app).get(`/recordings/${r._id}`).set('x-user', String(rep._id))).status).toBe(403);
    const share = await request(app).post(`/recordings/${r._id}/shares`); const shareId = share.body.data.shareId;
    expect((await request(app).get(`/shares/${shareId}`).set('x-user', String(rep._id))).status).toBe(403);
    const authCookie = `crm_token=${await issueCrmSessionToken(String(boss._id))}`;
    const session = await request(app).post(`/recordings/${r._id}/media`).set('Cookie', authCookie).send({ mode: 'play', fileId: String(r.files[0]._id), shareId }); expect(session.status).toBe(200);
    const cookie = [authCookie, ...session.headers['set-cookie'].map((value: string) => value.split(';')[0])]; expect((await request(app).get(session.body.data.path).set('Cookie', cookie)).status).toBe(200);
    await request(app).delete(`/shares/${shareId}`); expect((await request(app).get(session.body.data.path).set('Cookie', cookie)).status).toBe(404);
    expect(await CallRecordingAudit.countDocuments({ recordingId: r._id, action: 'playback.accessed' })).toBe(1);
    await request(app).post(`/recordings/${r._id}/review`); expect(await CallRecordingAudit.countDocuments({ recordingId: r._id, action: 'recording.reviewed' })).toBe(1);
    const download = await request(app).post(`/recordings/${r._id}/media`).set('Cookie', authCookie).send({ mode: 'download', fileId: String(r.files[0]._id) });
    const downloadCookies = [authCookie, ...download.headers['set-cookie'].map((value: string) => value.split(';')[0])];
    const downloaded = await request(app).get(download.body.data.path).set('Cookie', downloadCookies); expect(downloaded.headers['content-disposition']).toContain('attachment');
    expect((await request(app).get(download.body.data.path)).status).toBe(401);
    await CallRecordingGrant.updateOne({ principalId: String(boss._id), organizationId: org }, { $pull: { permissions: 'download' } });
    expect((await request(app).get(download.body.data.path).set('Cookie', downloadCookies)).status).toBe(403);
    await CallRecordingGrant.updateOne({ principalId: String(boss._id), organizationId: org }, { $addToSet: { permissions: 'download' } });
    await CallRecording.updateOne({ _id: r._id }, { $set: { expiresAt: new Date(Date.now() - 1) } }); await recoverRecordings();
    expect(storage.deleteRecordingFile).toHaveBeenCalled(); expect(provider.deleteProviderRecording).toHaveBeenCalledWith(`provider-${stamp}`); expect((await CallRecording.findById(r._id)).state).toBe('deleted');
  });
});
