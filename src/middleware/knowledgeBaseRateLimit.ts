import rateLimit from 'express-rate-limit';
import { ApiError } from '../utils/ApiError';

export const knowledgeBaseWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  skip: () => process.env.SKIP_RATE_LIMIT === 'true',
  keyGenerator: (req: any) => `knowledge-base:${String(req.orgId || '')}:${String(req.crmUser?._id || req.ip)}`,
  handler: (_req, _res, next) => {
    next(new ApiError(429, 'Too many Knowledge Base changes. Wait a minute and try again.'));
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { default: false },
});
