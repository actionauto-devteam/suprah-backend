import { Request } from 'express';
import Session from '../models/Session.model';
import User from '../models/User.model';
import CrmUser from '../models/CrmUser.model';
import tokenService from './token.service';
import { activeCrmSession, authTokenHash } from '../middleware/crmAuth.middleware';
import { ApiError } from '../utils/ApiError';
import { recordingPrincipal, RecordingPrincipal } from './callRecordingAccess.service';
import { CallRecordingMediaSession } from '../models/CallRecording.model';

export async function revokeRecordingMediaForLogin(req: Request) {
  const tokens = [req.cookies?.crm_token, req.header('authorization')?.replace(/^Bearer /, '')].filter((value): value is string => Boolean(value));
  const sessions = await Session.find({ refreshTokenHash: { $in: [...tokens, req.cookies?.refreshToken].filter(Boolean).map(authTokenHash) } });
  const ids = sessions.map(session => String(session.authKind === 'crm' ? session._id : session.familyId || session._id));
  if (ids.length) await CallRecordingMediaSession.deleteMany({ authSessionId: { $in: ids } });
}

export async function recordingMediaAuth(req: Request, expected?: RecordingPrincipal) {
  const crmToken = req.cookies?.crm_token || (expected ? req.crmAuthToken : undefined);
  if (crmToken) {
    const { session, userId } = await activeCrmSession(crmToken);
    const user = await CrmUser.findById(userId);
    if (!user) throw new ApiError(401, 'CRM account unavailable');
    const p = await recordingPrincipal(userId, String(user.organizationId), 'crm');
    if (session.parentSessionFamilyId) {
      const parent = await Session.findOne({ $or: [{ familyId: session.parentSessionFamilyId }, { _id: session.parentSessionFamilyId }], expiresAt: { $gt: new Date() }, rotatedAt: { $exists: false }, revokedAt: { $exists: false } });
      if (!parent || !await User.exists({ _id: parent.userId, isActive: true, organizationId: p.orgId })) throw new ApiError(401, 'Login account unavailable');
    }
    if (expected && (p.id !== expected.id || p.kind !== expected.kind || p.orgId !== expected.orgId)) throw new ApiError(401, 'Login identity changed');
    return { p, authKind: 'crm', authSessionId: String(session._id), authUserId: userId, crmToken };
  }
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) throw new ApiError(401, 'Active login required for recording media');
  const payload = tokenService.verifyRefreshToken(refreshToken);
  const session = await Session.findOne({ refreshTokenHash: authTokenHash(refreshToken), userId: payload.sub, expiresAt: { $gt: new Date() }, revokedAt: { $exists: false } });
  if (!session) throw new ApiError(401, 'Login session is no longer active');
  if (await Session.exists({ $or: [{ familyId: session.familyId || session._id }, { _id: session.familyId || session._id }], revokedAt: { $exists: true } })) throw new ApiError(401, 'Login session revoked');
  const user = await User.findById(payload.sub);
  if (!user?.isActive || !user.organizationId) throw new ApiError(401, 'Login account unavailable');
  if (expected) {
    if (!req.mainAuthToken) throw new ApiError(401, 'Authenticated login required');
    const access = tokenService.verifyAccessToken(req.mainAuthToken);
    if (access.sub !== String(user._id) || access.orgId !== String(user.organizationId)) throw new ApiError(401, 'Login identity changed');
  }
  const linked = await CrmUser.findOne({ email: user.email.toLowerCase(), organizationId: user.organizationId });
  const p = await recordingPrincipal(String(linked?._id || user._id), String(user.organizationId), linked ? 'crm' : 'main');
  if (expected && (p.id !== expected.id || p.kind !== expected.kind || p.orgId !== expected.orgId)) throw new ApiError(401, 'Login identity changed');
  return { p, authKind: 'main', authSessionId: String(session.familyId || session._id), authUserId: String(user._id), crmToken: undefined };
}
