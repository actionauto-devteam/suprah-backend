import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/demoLab.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/status', ctrl.getStatus);
router.get('/scenarios', ctrl.listScenarios);
router.post('/scenarios', ctrl.createScenario);
router.delete('/scenarios', ctrl.resetDemoData);
router.post('/scenarios/:leadId/reminder', ctrl.sendReminder);
router.post('/scenarios/:leadId/reply', ctrl.simulateReply);
router.post('/scenarios/:leadId/no-show', ctrl.markNoShow);
router.post('/scenarios/:leadId/no-show-followup', ctrl.sendNoShowFollowUp);
router.post('/scenarios/:leadId/nurture', ctrl.sendNurture);

export default router;
