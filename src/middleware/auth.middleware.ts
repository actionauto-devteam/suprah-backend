import passport from 'passport';
import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';

// Export AuthRequest interface
export interface AuthRequest extends Request {
    user?: IUser;
}

const verifyCallback = (req: Request, resolve: any, reject: any) => async (err: any, user: IUser, info: any) => {
    if (err || info || !user) {
        const message = info?.message || 'Please authenticate';
        return reject(new ApiError(401, message));
    }
    req.user = user;
    resolve();
};

const auth = () => async (req: Request, res: Response, next: NextFunction) => {
    return new Promise((resolve, reject) => {
        passport.authenticate('jwt', { session: false }, verifyCallback(req, resolve, reject))(req, res, next);
    })
        .then(() => next())
        .catch((err) => next(err));
};

export default auth;