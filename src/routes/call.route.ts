import express from 'express';
import callController from '../controllers/call.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

// All call routes require CRM authentication (same gate as SupraSpace).
router.use(crmAuth());

router.post('/start', callController.startCall);
router.post('/join', callController.joinCall);
router.post('/end', callController.endCall);
router.get('/:conversationId/status', callController.getCallStatus);

export default router;
