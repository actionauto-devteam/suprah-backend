import express from 'express';
import * as ctrl from '../controllers/webchat.controller';
import {
  webchatStartLimiter,
  webchatMessageLimiter,
  webchatSyncLimiter,
} from '../middleware/rate-limit.middleware';

const router = express.Router();

router.post('/public/sessions', webchatStartLimiter, ctrl.startSession);
router.post('/public/sessions/:sessionId/messages', webchatMessageLimiter, ctrl.sendVisitorMessage);
router.post('/public/sessions/:sessionId/sync', webchatSyncLimiter, ctrl.syncVisitorMessages);

export default router;
