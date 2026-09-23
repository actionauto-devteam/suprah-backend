import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import * as ctrl from '../controllers/webchat.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/leads/:leadId/messages', ctrl.getLeadWebChat);
router.post('/leads/:leadId/messages', ctrl.sendStaffMessage);
router.post('/leads/:leadId/typing', ctrl.pingTyping);

export default router;
