import express from 'express';
import yapLineController from '../controllers/yapline.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

// All YapLine reads require a CRM identity — same dual-token gate as SupraSpace.
router.use(crmAuth());

router.get('/sessions', yapLineController.getActiveSessions);
router.get('/recent',   yapLineController.getRecentActivity);

export default router;