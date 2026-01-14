import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';

const authorize = (roles: string | string[]) => (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as IUser;
    if (!user || (typeof roles === 'string' && user.role !== roles) || (Array.isArray(roles) && !roles.includes(user.role))) {
        return next(new ApiError(403, 'Forbidden'));
    }
    next();
};

export default authorize;
