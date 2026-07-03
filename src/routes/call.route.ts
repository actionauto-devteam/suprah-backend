import express from 'express';
import callController from '../controllers/call.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

// All call routes require CRM authentication (same gate as SupraSpace).
router.use(crmAuth());

router.get('/my-active-call', callController.getMyActiveCall);
router.post('/meeting/schedule', callController.scheduleMeeting);
router.post('/meeting', callController.createMeeting);
router.get('/meeting/:meetingId', callController.getMeeting);
router.post('/meeting/:meetingId/admission', callController.decideMeetingAdmission);
router.post('/meeting/:meetingId/grant-recording', callController.grantRecording);
router.delete('/meeting/:meetingId/grant-recording', callController.revokeRecording);
router.post('/meeting/:meetingId/recording/start', callController.startCallRecording);
router.post('/meeting/:meetingId/recording/stop', callController.stopCallRecording);
router.post('/start', callController.startCall);
router.post('/join', callController.joinCall);
router.post('/end', callController.endCall);
router.get('/:conversationId/status', callController.getCallStatus);

export default router;
