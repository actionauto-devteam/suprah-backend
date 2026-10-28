import express, { NextFunction, Request, Response } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import { crmExtensionSignInCodeLimiter } from '../middleware/rate-limit.middleware';
import { ApiError } from '../utils/ApiError';
import { createSignInCodeHandler } from '../controllers/crmExtension.controller';
import { extensionApiEnabled } from './crmExtension.routes';

const router = express.Router();

router.use(crmAuth());
router.use((_req: Request, _res: Response, next: NextFunction) => {
  if (!extensionApiEnabled()) return next(new ApiError(403, 'The Suprah CRM extension is not turned on for this server yet'));
  next();
});

router.post('/code', crmExtensionSignInCodeLimiter, createSignInCodeHandler);

export default router;
