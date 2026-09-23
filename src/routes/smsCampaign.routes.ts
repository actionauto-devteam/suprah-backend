import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/smsCampaign.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/audience-count', ctrl.getAudienceCount);
router.get('/', ctrl.listCampaigns);
router.post('/', ctrl.createCampaign);
router.get('/:id', ctrl.getCampaign);
router.post('/:id/cancel', ctrl.cancelCampaign);

export default router;
