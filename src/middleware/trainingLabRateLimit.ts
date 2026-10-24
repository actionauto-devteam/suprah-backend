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

export const staffAiDraftLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  skip: () => process.env.SKIP_RATE_LIMIT === 'true',
  keyGenerator: (req: any) => `staff-ai-draft:${String(req.orgId || '')}:${String(req.crmUser?._id || req.user?._id || req.ip)}`,
  handler: (_req, _res, next) => {
    next(new ApiError(429, "You're asking for suggestions too quickly. Wait a minute and try again.", [{ code: 'AI_DRAFT_RATE_LIMITED' }]));
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { default: false },
});
