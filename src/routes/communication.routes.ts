import express from "express";
import crmAuth from "../middleware/crmAuth.middleware";
import * as ctrl from "../controllers/communication.controller";
import * as recording from '../controllers/callRecording.controller';
import { listRoutingConfigs, saveRoutingConfig } from '../controllers/callRoutingConfig.controller';

const router = express.Router();
router.use((req, res, next) => {
  if (req.path.startsWith('/record') || /^\/calls\/[^/]+\/recording(?:\/|$)/.test(req.path)) res.setHeader('Cache-Control', 'private, no-store');
  next();
});

router.get('/recordings/media/:id', recording.mediaSession);
router.use(crmAuth());
router.get('/recording-settings', recording.getSettings);
router.post('/recording-settings', recording.savePolicy);
router.put('/recording-settings/:id', recording.savePolicy);
router.put('/recording-grants', recording.saveGrant);
router.get('/calls/:id/recording', recording.getCallRecording);
router.post('/calls/:id/recording/control', recording.control);
router.get('/recording-shares/:id', recording.resolveShare);
router.delete('/recording-shares/:id', recording.revokeShare);
router.get('/recordings/:id', recording.getRecording);
router.post('/recordings/:id/review', recording.reviewRecording);
router.post('/recordings/:id/retry', recording.retryImport);
router.delete('/recordings/:id', recording.removeRecording);
router.post('/recordings/:id/shares', recording.createShare);
router.post('/recordings/:id/media-session', recording.createMediaSession);

router.get('/ivr-configs', listRoutingConfigs);
router.post('/ivr-configs', saveRoutingConfig);
router.put('/ivr-configs/:id', saveRoutingConfig);

router.get("/conversations", ctrl.listConversations);
router.get("/threads/by-phone", ctrl.getThreadByPhone);
router.post("/messages", ctrl.sendMessage);
router.get("/lookup", ctrl.lookupCaller);
router.get("/calls/ringing", ctrl.listRingingCalls);
router.post("/calls/log", ctrl.logClientCall);
router.get("/calls", ctrl.listCalls);
router.post("/rtc/token", ctrl.getRtcToken);
router.get("/customers/:customerId/thread", ctrl.getCustomerThread);
router.get("/leads/:leadId/timeline", ctrl.getLeadTimeline);
router.post("/leads/:leadId/ai-pause", ctrl.pauseSmsAi);
router.post("/leads/:leadId/ai-resume", ctrl.resumeSmsAi);

router.get("/conversations/:id/messages", ctrl.getConversationMessages);
router.post("/conversations/:id/reply", ctrl.replyToConversation);
router.post("/calls/:id/claim", ctrl.claimCall);

export default router;
