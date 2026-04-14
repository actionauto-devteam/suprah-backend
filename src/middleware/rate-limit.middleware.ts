import rateLimit from 'express-rate-limit';
import { ApiError } from '../utils/ApiError';

/**
 * General Auth Rate Limiter
 * 5 requests per 15 minutes per IP/Email
 */
export const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => {
        // Identity-Based Throttling (Senior Engineer requirement)
        return req.body?.email || req.ip;
    },
    message: {
        success: false,
        message: 'We noticed multiple login attempts. To keep your account secure, please wait 15 minutes before trying again.',
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false }
});

/**
 * OTP Flood Guard
 * 3 requests per 3 minutes per IP/Email
 */
export const otpLimiter = rateLimit({
    windowMs: 3 * 60 * 1000,
    max: 3,
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => {
        return req.body?.email || req.ip;
    },
    message: {
        success: false,
        message: 'We sent you a code recently. To prevent spam, please wait 3 minutes before requesting a new one.',
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false }
});

/**
 * ADF Webhook Limiter
 * 60 requests per 15 minutes per Organization
 * Uses orgId instead of IP to avoid blocking shared vendor IPs (Cars.com, etc.)
 */
export const adfLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => {
        return (req.query.orgId || req.body.organizationId || req.ip).toString();
    },
    message: {
        success: false,
        message: 'We are receiving a high volume of leads right now. Please wait a moment while we process them.',
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false }
});

/**
 * Lead Sync Limiter
 * 5 requests per 15 minutes per User
 */
export const syncLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60, // Increased from 5 to 60 to allow 30s auto-sync interval
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => {
        return req.user?._id?.toString() || req.ip;
    },
    message: {
        success: false,
        message: 'We are currently syncing your new leads from Gmail. Please wait a moment for the process to complete.',
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false }
});

/**
 * Lead Reply Limiter
 * 30 requests per 15 minutes per User
 */
export const replyLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => {
        return req.user?._id?.toString() || req.ip;
    },
    message: {
        success: false,
        message: 'You have sent quite a few replies recently. Please take a short break before sending more.',
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false }
});
/**
 * File Upload Limiter
 * 5 requests per 10 minutes per User/IP
 * Protects against storage flooding and resource exhaustion
 */
export const uploadLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => {
        // Track by User ID (Standard Auth or CRM Auth) or IP
        return (req.user?._id || req.crmUser?._id || req.ip).toString();
    },
    message: {
        success: false,
        message: "You've reached the limit for file uploads. To ensure system stability for all users, please wait 10 minutes before trying again. If you need to upload multiple files, try sending them in a single batch (max 5).",
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false }
});
/**
 * Global Rate Limiter
 * 200 requests per 15 minutes per IP
 * Standard protection for all routes to prevent resource exhaustion
 */
export const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,

    skip: (req: any) => {
        // Skip rate limit for internal health checks or if explicitly disabled
        return process.env.SKIP_RATE_LIMIT === 'true' || req.path === '/health';
    },
    message: {
        success: false,
        message: 'Too many requests from this IP, please try again after 15 minutes',
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false }
});

/**
 * Heavy Inventory Sync Limiter
 * 2 requests per 5 minutes per user
 * Prevents multiple manual syncs from overlapping and locking the DB
 */
export const inventorySyncLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 2,
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => {
        return req.user?._id?.toString() || req.ip;
    },
    message: {
        success: false,
        message: 'An inventory sync is already in progress or was recently completed. Please wait 5 minutes before triggering again.',
    },
    handler: (req, res, next, options) => {
        next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false }
});
