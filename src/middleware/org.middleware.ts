import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

/**
 * Middleware to require an organization context.
 * This ensures the request is being made on behalf of a specific organization.
 */
export const requireOrg = (req: Request, res: Response, next: NextFunction) => {
    const orgId = req.auth?.orgId || req.orgId;
    const user = req.user as any;

    if (!orgId) {
        // Super admins can operate without an org — use "global" scope
        if (user?.role === 'super_admin') {
            req.orgId = 'global';
            return next();
        }
        // Drivers don't join Clerk orgs — use their organizationId from the DB
        if (user?.role === 'driver' && user?.organizationId) {
            req.orgId = user.organizationId.toString();
            return next();
        }
        return next(new ApiError(403, 'Organization context required. Please select an organization.'));
    }

    next();
};
