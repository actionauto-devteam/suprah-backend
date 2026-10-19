import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

export const requireRole = (requiredRoles: string[]) => (req: Request, res: Response, next: NextFunction) => {
    const userRole = req.auth?.orgRole || req.orgRole;

    console.log(`[RBACMiddleware] RequiredRoles: ${requiredRoles.join(', ')}, UserOrgRole: ${userRole}`);

    if (!userRole || !requiredRoles.includes(userRole)) {
        return next(new ApiError(403, "Your role in this organization can't do this. Ask an organization admin if you need access."));
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
        return next(new ApiError(
            403,
            allowedRoles.length === 1 && allowedRoles[0] === 'super_admin'
                ? "Only the Suprah team can do this. If you think you should have access, contact support@suprahai.com."
                : "Your account can't do this. If you think you should have access, contact support@suprahai.com.",
        ));
    }

    next();
};

/**
 * Shorthand for admin role requirement
 */
export const requireAdmin = requireRole(['admin']);
export const requireSuperAdmin = requireGlobalRole(['super_admin']);
