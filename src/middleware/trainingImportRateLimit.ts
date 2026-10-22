import rateLimit from 'express-rate-limit';
import { ApiError } from '../utils/ApiError';

function createTrainingImportLimiter(options: { windowMs: number; max: number }) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    skip: () => process.env.SKIP_RATE_LIMIT === 'true',
    keyGenerator: (req: any) => `training-import:${String(req.orgId || '')}:${String(req.crmUser?._id || req.ip)}`,
    handler: (_req, _res, next) => {
      next(new ApiError(429, 'Too many import requests. Wait a minute and try again.'));
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { default: false },
  });
}

export const trainingImportPreviewLimiter = createTrainingImportLimiter({ windowMs: 60 * 1000, max: 30 });

export const trainingImportWriteLimiter = createTrainingImportLimiter({ windowMs: 60 * 1000, max: 10 });
