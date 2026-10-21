import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/aiOperatingMode.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', ctrl.getAiModes);
router.get('/history', ctrl.getAiModeHistory);
router.patch('/', ctrl.updateAiModes);
router.patch('/shadow-drafts', ctrl.updateShadowDrafts);

export default router;
