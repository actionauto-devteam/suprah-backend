import express from 'express';
import customerCallController from '../controllers/customerCall.controller';
import mainAuth from '../middleware/auth.middleware';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();


router.get('/init', mainAuth(), customerCallController.init);
router.post('/request', mainAuth(), customerCallController.requestCall);
router.get('/messages', mainAuth(), customerCallController.getCustomerMessages);
router.get('/video-token', mainAuth(), customerCallController.getCustomerVideoToken);

router.get('/crm/conversations', crmAuth(), customerCallController.crmGetConversations);
router.get('/crm/conversations/:id/messages', crmAuth(), customerCallController.crmGetMessages);
router.post('/crm/conversations/:id/status', crmAuth(), customerCallController.crmSendStatus);
router.post('/crm/conversations/:id/start', crmAuth(), customerCallController.crmStartCall);
router.post('/crm/conversations/:id/end', crmAuth(), customerCallController.crmEndCall);
router.get('/crm/conversations/:id/video-token', crmAuth(), customerCallController.crmGetVideoToken);

export default router;