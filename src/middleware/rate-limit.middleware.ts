import rateLimit from 'express-rate-limit';
import { ApiError } from '../utils/ApiError';

/**
 * General Auth Rate Limiter
 * 5 requests per 15 minutes per IP/Email
 */
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    keyGenerator: (req: any) => {
        // Identity-Based Throttling (Senior Engineer requirement)
        return req.body?.email || req.ip;
    },
    message: {
        success: false,
        message: 'Too many login/registration attempts, please try again after 15 minutes',
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * OTP Flood Guard
 * 3 requests per 3 minutes per IP/Email
 */
export const otpLimiter = rateLimit({
    windowMs: 3 * 60 * 1000,
    max: 3,
    keyGenerator: (req: any) => {
        return req.body?.email || req.ip;
    },
    message: {
        success: false,
        message: 'Too many OTP requests. Please wait 3 minutes before trying again.',
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
});
