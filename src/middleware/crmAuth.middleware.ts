import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import CrmUser, { ICrmUser } from '../models/CrmUser.model';
import User from '../models/User.model';
import { ApiError } from '../utils/ApiError';
import tokenService from '../services/token.service';

// Extend Express Request for CRM auth
declare global {
  namespace Express {
    interface Request {
      crmUser?: ICrmUser;
    }
  }
}

const CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key';
const CRM_TOKEN_COOKIE = 'crm_token';

/**
 * Generate JWT for CRM user
 */
export const generateCrmToken = (userId: string): string => {
  return jwt.sign({ id: userId, type: 'crm' }, CRM_JWT_SECRET, {
    expiresIn: '12h',
  });
};

/**
 * CRM authentication middleware
 *
 * Accepts two token types — tried in order:
 * 1. crm_token (cookie or Bearer) — for CRM employees who logged in via the CRM login page
 * 2. Main app access token (Bearer) — for dealers/org owners already logged into SupraSpace;
 *    the org is read directly from the token payload (orgId claim), no extra DB round-trip needed
 */
const crmAuth = () => async (req: Request, res: Response, next: NextFunction) => {
  try {
    // ── 1. Try CRM token (cookie first, then header) ────────────────────────
    let crmToken = req.cookies?.[CRM_TOKEN_COOKIE];
    if (!crmToken) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const candidate = authHeader.split(' ')[1];
        // Peek at the payload to decide which type this token is
        try {
          const peeked = jwt.decode(candidate) as { type?: string } | null;
          if (peeked?.type === 'crm') crmToken = candidate;
        } catch {
          // not a valid JWT — will fail below
        }
      }
    }

    if (crmToken) {
      // Verify as CRM token
      const decoded = jwt.verify(crmToken, CRM_JWT_SECRET) as { id: string; type: string };

      if (decoded.type !== 'crm') throw new ApiError(401, 'Invalid CRM token');

      const crmUser = await CrmUser.findById(decoded.id);
      if (!crmUser) throw new ApiError(401, 'CRM user not found');
      if (!crmUser.isActive) throw new ApiError(403, 'CRM account has been deactivated');

      req.crmUser = crmUser;
      return next();
    }

    // ── 2. Fall back to main app Bearer token (dealer / org-owner path) ─────
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const mainToken = authHeader.split(' ')[1];

      let payload;
      try {
        payload = tokenService.verifyAccessToken(mainToken);
      } catch {
        throw new ApiError(401, 'CRM authentication required. Please log in.');
      }

      if (!payload.orgId) {
        throw new ApiError(403, 'Your account is not linked to any organization.');
      }

      const mainUser = await User.findById(payload.sub).select('name email role isActive organizationId');
      if (!mainUser || !mainUser.isActive) {
        throw new ApiError(401, 'Account not found or inactive');
      }

      // Build a minimal ICrmUser-compatible object from the main User record.
      // Org owners/admins in SupraSpace are treated as CRM admins automatically.
      const syntheticCrmUser = Object.assign(Object.create(CrmUser.prototype), {
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
      }) as ICrmUser;

      req.crmUser = syntheticCrmUser;
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

    next(new ApiError(401, 'CRM authentication failed'));
  }
};

export { CRM_TOKEN_COOKIE, CRM_JWT_SECRET };
export default crmAuth;