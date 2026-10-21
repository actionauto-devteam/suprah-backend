import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/aiAgentTask.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', ctrl.listAiAgentTasks);
router.post('/:id/resolve', ctrl.resolveAiAgentTask);
router.post('/:id/dismiss', ctrl.dismissAiAgentTask);
router.get('/:id/recovery', ctrl.previewTechnicalTaskRecovery);
router.post('/:id/recover', ctrl.recoverTechnicalTask);

export default router;
