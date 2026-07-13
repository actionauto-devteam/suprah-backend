import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';

export const requireOrg = (req: Request, res: Response, next: NextFunction) => {
    const orgId = req.auth?.orgId || req.orgId;
    const user = req.user as any;

    if (!orgId) {
        if (user?.role === 'super_admin') {
            req.orgId = 'global';
            return next();
        }
        if (user?.role === 'driver' && user?.organizationId) {
            req.orgId = user.organizationId.toString();
            return next();
        }
        return next(new ApiError(403, 'Organization context required. Please select an organization.'));
    }

    next();
};
