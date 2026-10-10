import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/aiAgentCoaching.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', ctrl.listAiAgentCoaching);
router.post('/', ctrl.createAiAgentCoaching);
router.patch('/:id', ctrl.updateAiAgentCoaching);
router.delete('/:id', ctrl.deleteAiAgentCoaching);

export default router;
