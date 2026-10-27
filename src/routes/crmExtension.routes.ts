import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import config from '../config';
import crmExtensionAuth from '../middleware/crmExtensionAuth.middleware';
import {
  crmExtensionLookupLimiter,
  crmExtensionNoteWriteLimiter,
  crmExtensionNotesLimiter,
  crmExtensionSendLimiter,
  crmExtensionSignInIpLimiter,
  crmExtensionSignInUserLimiter,
} from '../middleware/rate-limit.middleware';
import { ApiError } from '../utils/ApiError';
import {
  addNoteHandler,
  aiPauseHandler,
  aiResumeHandler,
  aiStatusHandler,
  createSessionHandler,
  deleteSessionHandler,
  getSessionHandler,
  historyHandler,
  lookupHandler,
  notesHandler,
  replyOptionsHandler,
  sendEmailHandler,
  sendTextHandler,
} from '../controllers/crmExtension.controller';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/([a-p]{32})$/;
const EXTENSION_ID = /^[a-p]{32}$/;

export function parseExtensionIds(raw: string | undefined) {
  return String(raw || '').split(',').map((id) => id.trim().toLowerCase()).filter((id) => EXTENSION_ID.test(id));
}

export function extensionApiEnabled(allowedIds = process.env.CRM_EXTENSION_IDS, production = config.env === 'production') {
  return !production || parseExtensionIds(allowedIds).length > 0;
}

export function isAllowedExtensionOrigin(origin: string | undefined, allowedIds = process.env.CRM_EXTENSION_IDS, production = config.env === 'production') {
  if (!extensionApiEnabled(allowedIds, production)) return false;
  if (!origin) return true;
  const match = EXTENSION_ORIGIN.exec(origin);
  if (!match) return false;
  const ids = parseExtensionIds(allowedIds);
  return !ids.length || ids.includes(match[1]);
}

const router = express.Router();

router.use(cors({
  origin: (origin, callback) => callback(null, isAllowedExtensionOrigin(origin)),
  credentials: false,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!extensionApiEnabled()) return next(new ApiError(403, 'The Suprah CRM extension is not turned on for this server yet'));
  if (!isAllowedExtensionOrigin(req.headers.origin)) return next(new ApiError(403, 'This request is only allowed from the Suprah CRM extension'));
  res.set('Cache-Control', 'no-store');
  next();
});

router.post('/session', crmExtensionSignInIpLimiter, crmExtensionSignInUserLimiter, createSessionHandler);
router.get('/session', crmExtensionAuth(), getSessionHandler);
router.delete('/session', crmExtensionAuth(), deleteSessionHandler);
router.post('/lookup', crmExtensionAuth(), crmExtensionLookupLimiter, lookupHandler);
router.get('/leads/:id/notes', crmExtensionAuth(), crmExtensionNotesLimiter, notesHandler);
router.post('/leads/:id/notes', crmExtensionAuth(), crmExtensionNoteWriteLimiter, addNoteHandler);
router.get('/leads/:id/history', crmExtensionAuth(), crmExtensionNotesLimiter, historyHandler);
router.get('/leads/:id/ai-status', crmExtensionAuth(), crmExtensionNotesLimiter, aiStatusHandler);
router.post('/leads/:id/ai-pause', crmExtensionAuth(), crmExtensionNotesLimiter, aiPauseHandler);
router.post('/leads/:id/ai-resume', crmExtensionAuth(), crmExtensionNotesLimiter, aiResumeHandler);
router.get('/leads/:id/reply-options', crmExtensionAuth(), crmExtensionNotesLimiter, replyOptionsHandler);
router.post('/leads/:id/sms', crmExtensionAuth(), crmExtensionSendLimiter, sendTextHandler);
router.post('/leads/:id/email', crmExtensionAuth(), crmExtensionSendLimiter, sendEmailHandler);

export default router;
