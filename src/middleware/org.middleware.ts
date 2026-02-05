import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

/**
 * Middleware to require an organization context.
 * This ensures the request is being made on behalf of a specific organization.
 */
export const requireOrg = (req: Request, res: Response, next: NextFunction) => {
    const orgId = req.auth?.orgId || req.orgId;

    if (!orgId) {
        return next(new ApiError(403, 'Organization context required. Please select an organization.'));
    }

    next();
};
