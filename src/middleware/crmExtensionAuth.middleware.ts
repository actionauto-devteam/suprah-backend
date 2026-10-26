import { Request, Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import mongoose from 'mongoose';
import { randomBytes } from 'crypto';
import CrmUser from '../models/CrmUser.model';
import Session from '../models/Session.model';
import { ApiError } from '../utils/ApiError';
import { CRM_JWT_SECRET, authTokenHash } from './crmAuth.middleware';

export const CRM_EXTENSION_TOKEN_TYPE = 'crm_ext';
export const CRM_EXTENSION_SESSION_TTL = '8h';

const bearerToken = (req: Request) => {
  const header = req.headers.authorization;
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
};

export async function issueCrmExtensionToken(userId: string) {
  const sessionId = new mongoose.Types.ObjectId();
  const options: SignOptions = { expiresIn: CRM_EXTENSION_SESSION_TTL as SignOptions['expiresIn'] };
  const token = jwt.sign(
    { id: userId, type: CRM_EXTENSION_TOKEN_TYPE, sid: String(sessionId), jti: randomBytes(16).toString('hex') },
    CRM_JWT_SECRET,
    options,
  );
  const { exp } = jwt.decode(token) as { exp: number };
  const expiresAt = new Date(exp * 1000);
  await Session.create({ _id: sessionId, authKind: 'crm', crmUserId: userId, refreshTokenHash: authTokenHash(token), expiresAt });
  return { token, expiresAt };
}

export async function revokeCrmExtensionToken(token: string) {
  if (!token) return;
  await Session.deleteMany({ authKind: 'crm', refreshTokenHash: authTokenHash(token) });
}

const crmExtensionAuth = () => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = bearerToken(req);
    if (!token) throw new ApiError(401, 'Please sign in to Suprah CRM');

    let payload: { id?: string; type?: string; sid?: string };
    try {
      payload = jwt.verify(token, CRM_JWT_SECRET) as typeof payload;
    } catch {
      throw new ApiError(401, 'Your Suprah session has expired. Please sign in again.');
    }
    if (payload.type !== CRM_EXTENSION_TOKEN_TYPE || !payload.id || !payload.sid || !mongoose.isValidObjectId(payload.sid)) {
      throw new ApiError(401, 'Please sign in to Suprah CRM');
    }

    const session = await Session.exists({
      _id: payload.sid,
      authKind: 'crm',
      crmUserId: payload.id,
      refreshTokenHash: authTokenHash(token),
      expiresAt: { $gt: new Date() },
    });
    if (!session) throw new ApiError(401, 'Your Suprah session has expired. Please sign in again.');

    const crmUser = await CrmUser.findById(payload.id);
    if (!crmUser || !crmUser.isActive) throw new ApiError(403, 'Your Suprah CRM account is not active');
    if (!crmUser.organizationId) throw new ApiError(403, 'Your account is not linked to a dealership');

    req.crmUser = crmUser;
    req.crmAuthToken = token;
    req.orgId = crmUser.organizationId.toString();
    next();
  } catch (error) {
    next(error instanceof ApiError ? error : new ApiError(500, 'Internal authentication error'));
  }
};

export default crmExtensionAuth;
