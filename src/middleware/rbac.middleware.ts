import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

/**
 * Middleware to require a specific role within an organization.
 * @param requiredRoles - Array of allowed roles (e.g., ['org:admin'])
 */
export const requireRole = (requiredRoles: string[]) => (req: Request, res: Response, next: NextFunction) => {
    const userRole = req.auth?.orgRole || req.orgRole;

    if (!userRole || !requiredRoles.includes(userRole)) {
        return next(new ApiError(403, 'Permission denied: Insufficient organization role.'));
    }

    next();
};

/**
 * Shorthand for admin role requirement
 */
export const requireAdmin = requireRole(['admin']);
