import { Request, Response, NextFunction } from 'express';
import jwt, { SignOptions } from 'jsonwebtoken';
import mongoose from 'mongoose';
import CrmUser, { ICrmUser } from '../models/CrmUser.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import tokenService from '../services/token.service';

declare global {
  namespace Express {
    interface Request {
      crmUser?: ICrmUser;
    }
  }
}

const CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key';
const CRM_TOKEN_COOKIE = 'crm_token';

export const generateCrmToken = (
  userId: string,
  expiresIn: string | number = '12h',
): string => {
  const options: SignOptions = { expiresIn: expiresIn as SignOptions['expiresIn'] };
  return jwt.sign({ id: userId, type: 'crm' }, CRM_JWT_SECRET, options);
};

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
      const decoded = jwt.verify(crmToken, CRM_JWT_SECRET) as { id: string; type: string };

      if (decoded.type !== 'crm') throw new ApiError(401, 'Invalid CRM token');

      const crmUser = await CrmUser.findById(decoded.id);
      if (!crmUser) throw new ApiError(403, 'CRM user not found');
      if (!crmUser.isActive) throw new ApiError(403, 'CRM account has been deactivated');

      req.crmUser = crmUser;
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

      const mainUser = await User.findById(payload.sub).select('name email role isActive organizationId');
      if (!mainUser) {
        throw new ApiError(401, 'Account not found or inactive');
      }
      if (!mainUser.isActive) {
        throw new ApiError(401, 'Account not found or inactive');
      }

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

      const syntheticCrmUser = {
        _id: mainUser._id,
        organizationId: new mongoose.Types.ObjectId(payload.orgId),
        fullName: mainUser.name,
        username: mainUser.email,
        email: mainUser.email,
        role: 'admin' as const,
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
