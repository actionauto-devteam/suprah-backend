import mongoose from 'mongoose';
import express from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Readable } from 'stream';
import jwt from 'jsonwebtoken';
jest.mock('../src/config', () => ({ __esModule: true, default: { bcryptSaltRounds: 4, jwt: { accessSecret: 'local-recording-access', refreshSecret: 'local-recording-refresh', accessExpiration: '15m', refreshExpiration: '7d' } } }));
jest.mock('../src/services/telnyx.service', () => ({}));
jest.mock('../src/services/email.service', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/membership.service', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/notification.service', () => ({ __esModule: true, default: {} }));
jest.mock('../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn() } }));
jest.mock('../src/services/callRecordingStorage.service', () => ({ streamRecordingFile: jest.fn(async () => ({ stream: Readable.from(Buffer.from('test-mp3')), length: 8, type: 'audio/mpeg' })) }));
import CrmUser from '../src/models/CrmUser.model';
import User from '../src/models/User.model';
import Session from '../src/models/Session.model';
import crmAuth, { issueCrmSessionToken, renewCrmSessionToken, revokeCrmSession, CRM_JWT_SECRET, generateCrmToken } from '../src/middleware/crmAuth.middleware';
import tokenService from '../src/services/token.service';
import authService from '../src/services/auth.service';
import authController from '../src/controllers/auth.controller';
import { asyncHandler } from '../src/utils/asyncHandler';
import { CallRecording, CallRecordingGrant, CallRecordingMediaSession, CallRecordingShare, CallRecordingAudit } from '../src/models/CallRecording.model';
import * as ctrl from '../src/controllers/callRecording.controller';
import * as storage from '../src/services/callRecordingStorage.service';
import { CallLog } from '../src/models/communication.model';
import { revokeRecordingMediaForLogin } from '../src/services/recordingMediaAuth.service';

const org = String(new mongoose.Types.ObjectId());
const otherOrg = String(new mongoose.Types.ObjectId());
const stamp = Date.now();
let a: any; let b: any; let foreign: any; let main: any; let record: any;
const app = express();
app.use(express.json()); app.use(cookieParser());
app.get('/api/crm/communications/recordings/media/:id', ctrl.mediaSession);
app.post('/api/crm/logout', asyncHandler(async (req, res) => { await revokeRecordingMediaForLogin(req); await revokeCrmSession(req, res); res.sendStatus(200); }));
app.post('/api/auth/logout', authController.logout);
app.post('/api/auth/refresh-tokens', authController.refreshTokens);
app.post('/recordings/:id/media-session', crmAuth(), ctrl.createMediaSession);
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ message: err.message }));
const pair = (response: any) => (response.headers['set-cookie'] || []).map((s: string) => s.split(';')[0]);
async function login(user = a) { const token = await issueCrmSessionToken(String(user._id)); return { token, cookies: [`crm_token=${token}`] }; }
async function media(auth: { token: string; cookies: string[] }, mode = 'play', shareId?: string) {
  const response = await request(app).post(`/recordings/${record._id}/media-session`).set('Authorization', `Bearer ${auth.token}`).set('Cookie', auth.cookies).send({ mode, fileId: String(record.files[0]._id), shareId });
  expect(response.status).toBe(200);
  return { path: response.body.data.path, cookies: [...auth.cookies, ...pair(response)] };
}
const read = (m: { path: string; cookies: string[] }) => request(app).get(m.path).set('Cookie', m.cookies);
beforeAll(async () => {
  const make = (tag: string, organizationId = org) => CrmUser.create({ organizationId, fullName: tag, username: `media-${tag}-${stamp}`, email: `media-${tag}-${stamp}@example.com`, password: 'Password123!', role: 'employee', isActive: true });
  a = await make('A'); b = await make('B'); foreign = await make('foreign', otherOrg);
  main = await User.create({ organizationId: org, name: 'Main media', email: `media-main-${stamp}@example.com`, password: 'Password123!', role: 'employee', isActive: true });
  for (const user of [a, b, foreign]) await CallRecordingGrant.create({ organizationId: String(user.organizationId), principalId: String(user._id), principalKind: 'crm', permissions: ['view', 'download'] });
  await CallRecordingGrant.create({ organizationId: org, principalId: String(main._id), principalKind: 'main', permissions: ['view', 'download'] });
  const call = await CallLog.create({ orgId: org, direction: 'inbound', from: '+18015550001', to: '+18015550002', status: 'completed' });
  record = await CallRecording.create({ organizationId: org, callLogId: call._id, direction: 'inbound', state: 'ready', endedAt: new Date(), expiresAt: new Date(Date.now() + 86400000), files: [{ key: 'private-fixture', bytes: 8, startedAt: new Date(), endedAt: new Date() }] });
});
beforeEach(() => jest.clearAllMocks());
afterAll(async () => {
  for (const model of [CallRecording, CallRecordingGrant, CallRecordingMediaSession, CallRecordingShare, CallRecordingAudit]) await model.deleteMany({ organizationId: { $in: [org, otherOrg] } });
  await Session.deleteMany({ $or: [{ crmUserId: { $in: [a._id, b._id, foreign._id] } }, { userId: main._id }] });
  await CrmUser.deleteMany({ _id: { $in: [a._id, b._id, foreign._id] } }); await User.deleteOne({ _id: main._id }); await CallLog.deleteMany({ orgId: org });
  await mongoose.disconnect();
});
describe('Recording media follows the originating authenticated login', () => {
  it('allows normal authenticated playback, ranges and download but rejects URL-only and media-cookie-only requests', async () => {
    const auth = await login(); const m = await media(auth);
    expect((await read(m)).status).toBe(200);
    expect((await read(m).set('Range', 'bytes=0-7')).status).toBe(206);
    expect((await request(app).get(m.path)).status).toBe(401);
    expect((await read({ ...m, cookies: m.cookies.filter(c => c.startsWith('recording_media=')) })).status).toBe(401);
    const download = await media(auth, 'download');
    expect((await read(download)).headers['content-disposition']).toContain('attachment');
  });
  it('logout revokes even saved copies of both authentication and media cookies', async () => {
    const auth = await login(); const m = await media(auth);
    expect((await request(app).post('/api/crm/logout').set('Cookie', auth.cookies)).status).toBe(200);
    expect((await read(m)).status).toBe(401);
    expect((await request(app).post(`/recordings/${record._id}/media-session`).set('Authorization', `Bearer ${auth.token}`).send({ mode: 'play', fileId: String(record.files[0]._id) })).status).toBe(401);
    expect(storage.streamRecordingFile).not.toHaveBeenCalled();
  });
  it('A logout followed by B login cannot reuse A media even if B has recording permission', async () => {
    const auth = await login(); const m = await media(auth);
    await request(app).post('/api/crm/logout').set('Cookie', auth.cookies);
    const second = await login(b);
    expect((await read({ ...m, cookies: [...second.cookies, ...m.cookies.filter(c => c.startsWith('recording_media='))] })).status).toBe(401);
    expect((await read(await media(second))).status).toBe(200);
  });
  it('another login for the same account cannot reuse a previous login media session', async () => {
    const m = await media(await login()); const next = await login();
    expect((await read({ ...m, cookies: [...next.cookies, ...m.cookies.filter(c => c.startsWith('recording_media='))] })).status).toBe(401);
  });
  it('permission revocation prevents subsequent playback and download without waiting for cookie expiry', async () => {
    const m = await media(await login());
    try {
      await CallRecordingGrant.updateOne({ principalId: String(a._id), organizationId: org }, { $set: { permissions: [] } });
      expect((await read(m)).status).toBe(403); expect(storage.streamRecordingFile).not.toHaveBeenCalled();
    } finally { await CallRecordingGrant.updateOne({ principalId: String(a._id), organizationId: org }, { $set: { permissions: ['view', 'download'] } }); }
  });
  it('deactivation prevents subsequent media access', async () => {
    const m = await media(await login());
    try { await CrmUser.updateOne({ _id: a._id }, { $set: { isActive: false } }); expect((await read(m)).status).toBe(403); }
    finally { await CrmUser.updateOne({ _id: a._id }, { $set: { isActive: true } }); }
  });
  it('foreign organizations and changed membership cannot reuse media', async () => {
    const auth = await login(); const m = await media(auth); const f = await login(foreign);
    expect((await read({ ...m, cookies: [...f.cookies, ...m.cookies.filter(c => c.startsWith('recording_media='))] })).status).toBe(401);
    expect((await request(app).post(`/recordings/${record._id}/media-session`).set('Cookie', f.cookies).send({ mode: 'play', fileId: String(record.files[0]._id) })).status).toBe(404);
    try { await CrmUser.updateOne({ _id: a._id }, { $set: { organizationId: otherOrg } }); expect((await read(m)).status).toBe(401); }
    finally { await CrmUser.updateOne({ _id: a._id }, { $set: { organizationId: org } }); }
  });
  it('expired JWTs, server sessions and media sessions fail closed', async () => {
    const auth = await login(); const m = await media(auth);
    const expired = jwt.sign({ id: String(a._id), type: 'crm', sid: (jwt.decode(auth.token) as any).sid }, CRM_JWT_SECRET, { expiresIn: -1 });
    expect((await read({ ...m, cookies: [`crm_token=${expired}`, ...m.cookies.filter(c => c.startsWith('recording_media='))] })).status).toBe(401);
    await Session.updateOne({ _id: (jwt.decode(auth.token) as any).sid }, { $set: { expiresAt: new Date(Date.now() - 1) } }); expect((await read(m)).status).toBe(401);
    const fresh = await media(await login()); await CallRecordingMediaSession.updateOne({ _id: fresh.path.split('/').pop() }, { $set: { expiresAt: new Date(Date.now() - 1) } }); expect((await read(fresh)).status).toBe(401);
  });
  it('legacy unbound media and legacy CRM JWTs require a new sign-in rather than being upgraded implicitly', async () => {
    const auth = await login(); const m = await media(auth);
    await CallRecordingMediaSession.updateOne({ _id: m.path.split('/').pop() }, { $unset: { authSessionId: '' } }); expect((await read(m)).status).toBe(401);
    expect((await request(app).post(`/recordings/${record._id}/media-session`).set('Cookie', `crm_token=${generateCrmToken(String(a._id))}`).send({ mode: 'play', fileId: String(record.files[0]._id) })).status).toBe(401);
  });
  it('CRM token renewal preserves login identity and rejects the old token', async () => {
    const auth = await login(); const m = await media(auth); const renewed = await renewCrmSessionToken(auth.token, String(a._id));
    expect((await read({ ...m, cookies: [`crm_token=${renewed}`, ...m.cookies.filter(c => c.startsWith('recording_media='))] })).status).toBe(200);
    expect((await read(m)).status).toBe(401);
  });
  it('revoked shares still block media within an otherwise authorized login', async () => {
    const share = await CallRecordingShare.create({ organizationId: org, recordingId: record._id, createdBy: String(a._id), expiresAt: new Date(Date.now() + 86400000) });
    const m = await media(await login(), 'play', String(share._id)); expect((await read(m)).status).toBe(200);
    await CallRecordingShare.updateOne({ _id: share._id }, { $set: { revokedAt: new Date() } }); expect((await read(m)).status).toBe(404);
  });
  it('main account media survives refresh rotation but is revoked by real logout, including saved old cookies', async () => {
    const tokens = await authService.login(main.email, 'Password123!');
    const auth = { token: tokens.accessToken, cookies: [`refreshToken=${tokens.refreshToken}`] }; const m = await media(auth);
    expect((await read(m)).status).toBe(200);
    const refreshed = await authService.refreshTokens(tokens.refreshToken);
    const rotated = { ...m, cookies: [`refreshToken=${refreshed.refreshToken}`, ...m.cookies.filter(c => c.startsWith('recording_media='))] };
    expect((await read(rotated)).status).toBe(200);
    expect((await request(app).post('/api/auth/logout').set('Cookie', `refreshToken=${refreshed.refreshToken}`)).status).toBe(200);
    expect((await read(rotated)).status).toBe(401); expect((await read(m)).status).toBe(401);
    await expect(authService.refreshTokens(tokens.refreshToken)).rejects.toThrow();
  });
  it('main account sessions cannot be replaced by another login or expired session', async () => {
    const first = await authService.login(main.email, 'Password123!'); const m = await media({ token: first.accessToken, cookies: [`refreshToken=${first.refreshToken}`] });
    const second = await authService.login(main.email, 'Password123!');
    expect((await read({ ...m, cookies: [`refreshToken=${second.refreshToken}`, ...m.cookies.filter(c => c.startsWith('recording_media='))] })).status).toBe(401);
    await authService.logout(first.refreshToken); expect((await read(m)).status).toBe(401);
    const old = tokenService.generateRefreshToken(main); expect((await read({ ...m, cookies: [`refreshToken=${old}`, ...m.cookies.filter(c => c.startsWith('recording_media='))] })).status).toBe(401);
  });
  it('main logout also revokes CRM SSO recording media issued from that login family', async () => {
    const tokens = await authService.login(main.email, 'Password123!'); const parent = await Session.findOne({ userId: main._id, refreshTokenHash: (await import('../src/middleware/crmAuth.middleware')).authTokenHash(tokens.refreshToken) });
    const token = await issueCrmSessionToken(String(a._id), '12h', parent!.familyId); const m = await media({ token, cookies: [`crm_token=${token}`] });
    expect((await read(m)).status).toBe(200); await authService.logout(tokens.refreshToken); expect((await read(m)).status).toBe(401);
  });
  it('exiting CRM revokes main-auth media while leaving the main login available', async () => {
    const tokens = await authService.login(main.email, 'Password123!'); const auth = { token: tokens.accessToken, cookies: [`refreshToken=${tokens.refreshToken}`] }; const m = await media(auth);
    await request(app).post('/api/crm/logout').set('Cookie', auth.cookies); expect((await read(m)).status).toBe(401);
    expect((await read(await media(auth))).status).toBe(200);
  });
  it('main-user deactivation and organization changes revoke subsequent media', async () => {
    const tokens = await authService.login(main.email, 'Password123!'); const m = await media({ token: tokens.accessToken, cookies: [`refreshToken=${tokens.refreshToken}`] });
    try {
      await User.updateOne({ _id: main._id }, { $set: { isActive: false } }); expect((await read(m)).status).toBe(401);
      await User.updateOne({ _id: main._id }, { $set: { isActive: true, organizationId: otherOrg } }); expect((await read(m)).status).toBe(401);
    } finally { await User.updateOne({ _id: main._id }, { $set: { isActive: true, organizationId: org } }); }
  });
  it('expired main refresh JWTs and database sessions cannot stream media', async () => {
    const tokens = await authService.login(main.email, 'Password123!'); const m = await media({ token: tokens.accessToken, cookies: [`refreshToken=${tokens.refreshToken}`] });
    const expired = jwt.sign({ sub: String(main._id), type: 'refresh' }, 'local-recording-refresh', { expiresIn: -1 });
    expect((await read({ ...m, cookies: [`refreshToken=${expired}`, ...m.cookies.filter(c => c.startsWith('recording_media='))] })).status).toBe(401);
    await Session.updateOne({ refreshTokenHash: (await import('../src/middleware/crmAuth.middleware')).authTokenHash(tokens.refreshToken) }, { $set: { expiresAt: new Date(Date.now() - 1) } }); expect((await read(m)).status).toBe(401);
  });
  it('revoked legacy login families cannot be revived by a delayed refresh result', async () => {
    const tokens = await authService.login(main.email, 'Password123!'); const root = await Session.findOne({ refreshTokenHash: (await import('../src/middleware/crmAuth.middleware')).authTokenHash(tokens.refreshToken) });
    await Session.updateOne({ _id: root!._id }, { $unset: { familyId: '' } });
    const m = await media({ token: tokens.accessToken, cookies: [`refreshToken=${tokens.refreshToken}`] }); await authService.logout(tokens.refreshToken);
    const delayed = tokenService.generateRefreshToken(main);
    await Session.create({ userId: main._id, familyId: root!._id, refreshTokenHash: (await import('../src/middleware/crmAuth.middleware')).authTokenHash(delayed), expiresAt: new Date(Date.now() + 86400000) });
    expect((await read({ ...m, cookies: [`refreshToken=${delayed}`, ...m.cookies.filter(c => c.startsWith('recording_media='))] })).status).toBe(401);
    await expect(authService.refreshTokens(delayed)).rejects.toThrow('revoked');
  });
});
