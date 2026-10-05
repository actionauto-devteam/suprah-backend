import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import suprahMeetController from '../controllers/suprahMeet.controller';

// NOTE: if your existing route file imports the auth middleware differently
// (named import / different filename), keep YOUR import + router.use line and
// just make sure every route below exists.

const router = Router();

// ── Public guest endpoints (NO auth — guests have no Suprah account). The
// guest pass JWT inside each request scopes them to one meeting code. ──
router.post('/guest/:code/request', suprahMeetController.guestRequest);
router.post('/guest/:code/join',    suprahMeetController.guestJoin);
router.post('/guest/:code/leave',   suprahMeetController.guestLeave);
router.get('/guest/:code/roster',   suprahMeetController.guestRoster);
router.get('/guest/recording/:code', suprahMeetController.recordingAccess); // token-gated

router.use(crmAuth());

router.post('/meetings',                        suprahMeetController.createMeeting);
router.get('/meetings',                         suprahMeetController.listMeetings);
router.get('/alerts',                           suprahMeetController.getAlerts);
router.get('/meetings/:code',                   suprahMeetController.getMeeting);
router.patch('/meetings/:code',                 suprahMeetController.updateMeeting);
router.delete('/meetings/:code',                suprahMeetController.deleteMeeting);

// Waiting room
router.post('/meetings/:code/request-join',     suprahMeetController.requestJoin);
router.get('/meetings/:code/waiting',           suprahMeetController.getWaiting);
router.post('/meetings/:code/waiting/:userId',  suprahMeetController.respondWaiting);

router.post('/meetings/:code/join',             suprahMeetController.joinMeeting);
router.post('/meetings/:code/leave',            suprahMeetController.leaveMeeting);
router.post('/meetings/:code/end',              suprahMeetController.endMeeting);
router.post('/meetings/:code/recording/start',  suprahMeetController.startRecording);
router.post('/meetings/:code/recording/stop',   suprahMeetController.stopRecording);
router.get('/meetings/:code/recordings',        suprahMeetController.getRecordings);
router.get('/meetings/:code/distribution',      suprahMeetController.getDistribution);
router.post('/meetings/:code/distribute',       suprahMeetController.distributeRecording);
router.post('/meetings/:code/ai/process',       suprahMeetController.processAi);
router.get('/meetings/:code/ai',                suprahMeetController.getAi);

export default router;
