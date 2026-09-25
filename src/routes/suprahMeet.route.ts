import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import suprahMeetController from '../controllers/suprahMeet.controller';

const router = Router();

// Everything in Suprah Meet requires a logged-in CRM user.
// NOTE: crmAuth is a factory — the () is required. Without it the router hangs.
router.use(crmAuth());

router.post('/meetings', suprahMeetController.createMeeting);
router.get('/meetings', suprahMeetController.listMeetings);
router.get('/alerts', suprahMeetController.getAlerts);
router.get('/meetings/:code', suprahMeetController.getMeeting);
router.delete('/meetings/:code', suprahMeetController.deleteMeeting);
router.post('/meetings/:code/join', suprahMeetController.joinMeeting);
router.post('/meetings/:code/leave', suprahMeetController.leaveMeeting);
router.post('/meetings/:code/end', suprahMeetController.endMeeting);
router.post('/meetings/:code/recording/start', suprahMeetController.startRecording);
router.post('/meetings/:code/recording/stop', suprahMeetController.stopRecording);
router.get('/meetings/:code/recordings', suprahMeetController.getRecordings);
router.post('/meetings/:code/ai/process', suprahMeetController.processAi);
router.get('/meetings/:code/ai', suprahMeetController.getAi);

export default router;