import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/aiShadowDraft.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', ctrl.listShadowDrafts);
router.get('/usage', ctrl.getShadowDraftUsage);
router.get('/:id', ctrl.getShadowDraft);

export default router;
