import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import CrmUser, { ICrmUser } from '../models/CrmUser.model';
import { ApiError } from '../utils/ApiError';

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
 * Reads token from httpOnly cookie or Authorization header as fallback
 */
const crmAuth = () => async (req: Request, res: Response, next: NextFunction) => {
  try {
    // 1. Extract token from cookie or header
    let token = req.cookies?.[CRM_TOKEN_COOKIE];

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      throw new ApiError(401, 'CRM authentication required. Please log in.');
    }

    // 2. Verify token
    const decoded = jwt.verify(token, CRM_JWT_SECRET) as { id: string; type: string };

    if (decoded.type !== 'crm') {
      throw new ApiError(401, 'Invalid CRM token');
    }

    // 3. Find user
    const user = await CrmUser.findById(decoded.id);

    if (!user) {
      throw new ApiError(401, 'CRM user not found');
    }

    if (!user.isActive) {
      throw new ApiError(403, 'CRM account has been deactivated');
    }

    // 4. Attach user to request
    req.crmUser = user;

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      // Clear expired cookie
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