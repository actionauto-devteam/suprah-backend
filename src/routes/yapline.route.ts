import express from 'express';
import yapLineController from '../controllers/yapline.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

// All YapLine reads require a CRM identity — same dual-token gate as SupraSpace.
router.use(crmAuth());

router.get('/sessions', yapLineController.getActiveSessions);
router.get('/recent',   yapLineController.getRecentActivity);
// ICE servers (STUN + ephemeral TURN credentials). Per-user and short-lived,
// so the TURN secret never reaches the browser.
router.get('/ice',      yapLineController.getIceConfig);

export default router;