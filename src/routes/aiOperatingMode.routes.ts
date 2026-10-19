import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/aiOperatingMode.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', ctrl.getAiModes);
router.patch('/', ctrl.updateAiModes);

export default router;
