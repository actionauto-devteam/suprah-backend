import rateLimit from 'express-rate-limit';
import { ApiError } from '../utils/ApiError';

export function createTrainingLabLimiter(options: { windowMs: number; max: number }) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => `training-lab:${String(req.orgId || '')}:${String(req.crmUser?._id || req.ip)}`,
    handler: (_req, _res, next) => {
      next(new ApiError(429, 'Too many Testing Lab requests. Wait a minute and try again.'));
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false },
  });
}

export const trainingLabWriteLimiter = createTrainingLabLimiter({ windowMs: 60 * 1000, max: 30 });

export const trainingLabCheckLimiter = createTrainingLabLimiter({ windowMs: 60 * 1000, max: 120 });
