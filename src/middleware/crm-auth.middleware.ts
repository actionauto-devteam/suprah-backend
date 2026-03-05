import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import CrmUser from '../models/CrmUser.model';

const JWT_SECRET = process.env.JWT_SECRET || 'crm_jwt_secret_change_me';

/**
 * CRM Authentication Middleware
 *
 * Validates the JWT Bearer token from the Authorization header
 * and attaches the full CrmUser document to `req.crmUser`.
 *
 * Usage in routes:
 *   router.get('/protected', crmAuthMiddleware, handler);
 */
export async function crmAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please sign in.',
      });
    }

    const token = authHeader.slice(7);
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      username: string;
      role: string;
    };

    const user = await CrmUser.findById(decoded.id);
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User account not found.',
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        message: 'Account has been deactivated. Contact your administrator.',
      });
    }

    (req as any).crmUser = user;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please sign in again.',
      });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token.',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Authentication error.',
    });
  }
}

/**
 * Role-based access control middleware.
 * Use after crmAuthMiddleware.
 *
 * Usage:
 *   router.get('/admin', crmAuthMiddleware, requireRole('admin'), handler);
 */
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).crmUser;
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions for this action.',
      });
    }
    next();
  };
}