import { Request, Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import mongoose from 'mongoose';
import CrmUser, { ICrmUser } from '../models/CrmUser.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import tokenService from '../services/token.service';
import Session from '../models/Session.model';
import { createHash, randomBytes } from 'crypto';

declare global {
  namespace Express {
    interface Request {
      crmUser?: ICrmUser;
      crmAuthToken?: string;
      mainAuthToken?: string;
    }
  }
}

const CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key';
const CRM_TOKEN_COOKIE = 'crm_token';

export const generateCrmToken = (
  userId: string,
  expiresIn: string | number = '12h',
  sessionId?: string,
): string => {
  const options: SignOptions = { expiresIn: expiresIn as SignOptions['expiresIn'] };
  return jwt.sign({ id: userId, type: 'crm', ...(sessionId ? { sid: sessionId, jti: randomBytes(16).toString('hex') } : {}) }, CRM_JWT_SECRET, options);
};

export const authTokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export async function issueCrmSessionToken(userId: string, expiresIn: string | number = '12h', parentSessionFamilyId?: mongoose.Types.ObjectId) {
  const id = new mongoose.Types.ObjectId();
  const token = generateCrmToken(userId, expiresIn, String(id));
  const payload = jwt.decode(token) as { exp: number };
  await Session.create({ _id: id, authKind: 'crm', crmUserId: userId, refreshTokenHash: authTokenHash(token), expiresAt: new Date(payload.exp * 1000), parentSessionFamilyId });
  return token;
}

export async function activeCrmSession(token: string) {
  let payload: { id: string; type: string; sid?: string };
  try {
    payload = jwt.verify(token, CRM_JWT_SECRET) as typeof payload;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) throw new ApiError(401, 'Invalid or expired CRM session');
    throw error;
  }
  if (payload.type !== 'crm' || !payload.sid || !mongoose.isValidObjectId(payload.sid)) throw new ApiError(401, 'Please sign in again to access recording media');
  const session = await Session.findOne({ _id: payload.sid, authKind: 'crm', crmUserId: payload.id, refreshTokenHash: authTokenHash(token), expiresAt: { $gt: new Date() } });
  if (!session) throw new ApiError(401, 'CRM session is no longer active');
  if (session.parentSessionFamilyId && (await Session.exists({ $or: [{ familyId: session.parentSessionFamilyId }, { _id: session.parentSessionFamilyId }], revokedAt: { $exists: true } }) || !await Session.exists({ $or: [{ familyId: session.parentSessionFamilyId }, { _id: session.parentSessionFamilyId }], expiresAt: { $gt: new Date() }, rotatedAt: { $exists: false }, revokedAt: { $exists: false } }))) throw new ApiError(401, 'Login session is no longer active');
  return { session, userId: payload.id };
}

export async function revokeCrmSession(req: Request, res: Response) {
  const bearer = req.header('authorization')?.replace(/^Bearer /, '');
  const tokens = [req.cookies?.[CRM_TOKEN_COOKIE], bearer].filter((value): value is string => Boolean(value));
  await Session.deleteMany({ authKind: 'crm', refreshTokenHash: { $in: tokens.map(authTokenHash) } });
  res.clearCookie(CRM_TOKEN_COOKIE, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
}

export async function renewCrmSessionToken(token: string, userId: string) {
  const decoded = jwt.decode(token) as { sid?: string } | null;
  if (!decoded?.sid) return issueCrmSessionToken(userId);
  const { session } = await activeCrmSession(token);
  const renewed = generateCrmToken(userId, '12h', String(session._id));
  const payload = jwt.decode(renewed) as { exp: number };
  const result = await Session.updateOne({ _id: session._id, refreshTokenHash: authTokenHash(token) }, { $set: { refreshTokenHash: authTokenHash(renewed), expiresAt: new Date(payload.exp * 1000) } });
  if (!result.matchedCount) throw new ApiError(401, 'CRM session is no longer active');
  return renewed;
}

const crmAuth = () => async (req: Request, res: Response, next: NextFunction) => {
  try {
    let crmToken = req.cookies?.[CRM_TOKEN_COOKIE];
    if (!crmToken) {
      const queryToken = req.query.t as string | undefined;
      const authHeader = req.headers.authorization;
      const candidate = queryToken || (authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined);
      if (candidate) {
        try {
          const peeked = jwt.decode(candidate) as { type?: string } | null;
          if (peeked?.type === 'crm') crmToken = candidate;
        } catch {
        }
      }
    }

    if (crmToken) {
      const decoded = jwt.verify(crmToken, CRM_JWT_SECRET) as { id: string; type: string; sid?: string };

      if (decoded.type !== 'crm') throw new ApiError(401, 'Invalid CRM token');
      if (decoded.sid) await activeCrmSession(crmToken);

      const crmUser = await CrmUser.findById(decoded.id);
      if (!crmUser) throw new ApiError(403, 'CRM user not found');
      if (!crmUser.isActive) throw new ApiError(403, 'CRM account has been deactivated');

      req.crmUser = crmUser;
      req.crmAuthToken = crmToken;
      req.orgId = crmUser.organizationId.toString();
      return next();
    }

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const mainToken = authHeader.split(' ')[1];

      let payload: any;
      try {
        payload = tokenService.verifyAccessToken(mainToken);
      } catch (err) {
        throw new ApiError(401, 'CRM authentication required. Please log in.');
      }

      if (!payload.orgId) {
        throw new ApiError(403, 'Your account is not linked to any organization.');
      }

      const mainUser = await User.findById(payload.sub).select('name email role organizationRole isActive organizationId');
      if (!mainUser) {
        throw new ApiError(401, 'Account not found or inactive');
      }
      if (!mainUser.isActive) {
        throw new ApiError(401, 'Account not found or inactive');
      }
      if (String(mainUser.organizationId) !== payload.orgId) throw new ApiError(403, 'Organization membership changed');
      req.mainAuthToken = mainToken;

      const linkedCrmUser = await CrmUser.findOne({
        email: mainUser.email.toLowerCase(),
        organizationId: payload.orgId,
      });
      if (linkedCrmUser) {
        if (!linkedCrmUser.isActive) throw new ApiError(403, 'CRM account has been deactivated');
        req.crmUser = linkedCrmUser;
        req.orgId = linkedCrmUser.organizationId.toString();
        return next();
      }

      if (!['employee', 'admin', 'super_admin'].includes(mainUser.role)) {
        throw new ApiError(403, 'CRM access requires an authorized staff account');
      }

      const syntheticCrmUser = {
        _id: mainUser._id,
        organizationId: new mongoose.Types.ObjectId(payload.orgId),
        fullName: mainUser.name,
        username: mainUser.email,
        email: mainUser.email,
        role: ['admin', 'super_admin'].includes(mainUser.role) || mainUser.organizationRole === 'admin'
          ? 'admin' as const
          : mainUser.organizationRole === 'manager' ? 'manager' as const : 'employee' as const,
        isActive: true,
        lastLoginAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as ICrmUser;

      req.crmUser = syntheticCrmUser;
      req.orgId = payload.orgId;
      return next();
    }

    throw new ApiError(401, 'CRM authentication required. Please log in.');

  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.clearCookie(CRM_TOKEN_COOKIE, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
      });
      return next(new ApiError(401, 'CRM session expired. Please log in again.'));
    }

    if (error instanceof jwt.JsonWebTokenError) {
      return next(new ApiError(401, 'Invalid CRM token'));
    }

    if (error instanceof ApiError) {
      return next(error);
    }

    console.error('[CRM-AUTH] Unexpected failure:', error);
    next(new ApiError(500, 'Internal authentication error'));
  }
};

export { CRM_TOKEN_COOKIE, CRM_JWT_SECRET };
export default crmAuth;
