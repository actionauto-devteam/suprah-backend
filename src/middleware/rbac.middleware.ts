import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

export const requireRole = (requiredRoles: string[]) => (req: Request, res: Response, next: NextFunction) => {
    const userRole = req.auth?.orgRole || req.orgRole;

    console.log(`[RBACMiddleware] RequiredRoles: ${requiredRoles.join(', ')}, UserOrgRole: ${userRole}`);

    if (!userRole || !requiredRoles.includes(userRole)) {
        return next(new ApiError(403, 'Permission denied: Insufficient organization role.'));
    }

    next();
};

/**
 * Middleware to require a global user role (e.g., 'super_admin').
 * @param allowedRoles - Array of allowed global roles
 */
export const requireGlobalRole = (allowedRoles: string[]) => (req: Request, res: Response, next: NextFunction) => {
    const userRole = req.user?.role;

    if (!userRole || !allowedRoles.includes(userRole)) {
        return next(new ApiError(403, 'Permission denied: Insufficient global role.'));
    }

    next();
};

/**
 * Shorthand for admin role requirement
 */
export const requireAdmin = requireRole(['admin']);
export const requireSuperAdmin = requireGlobalRole(['super_admin']);
