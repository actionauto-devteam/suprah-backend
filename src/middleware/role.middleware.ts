import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';

const authorize = (roles: string | string[]) => (req: Request, res: Response, next: NextFunction) => {
    const userRole = req.user?.role;
    const orgRole = req.orgRole;
    
    const allowedRoles = Array.isArray(roles) ? roles : [roles];
    
    const hasGlobalRole = userRole && allowedRoles.includes(userRole);
    const hasOrgRole = orgRole && allowedRoles.includes(orgRole);

    if (!hasGlobalRole && !hasOrgRole) {
        return next(new ApiError(403, 'Forbidden'));
    }
    next();
};

export default authorize;
