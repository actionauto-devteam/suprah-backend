import express from "express";
import crmAuth from "../middleware/crmAuth.middleware";
import * as ctrl from "../controllers/communication.controller";

const router = express.Router();

router.use(crmAuth());

router.get("/conversations", ctrl.listConversations);
router.get("/threads/by-phone", ctrl.getThreadByPhone);
router.post("/messages", ctrl.sendMessage);
router.get("/lookup", ctrl.lookupCaller);
router.get("/calls/ringing", ctrl.listRingingCalls);
router.post("/calls/log", ctrl.logClientCall);
router.get("/calls", ctrl.listCalls);
router.post("/rtc/token", ctrl.getRtcToken);
router.get("/customers/:customerId/thread", ctrl.getCustomerThread);

router.get("/conversations/:id/messages", ctrl.getConversationMessages);
router.post("/conversations/:id/reply", ctrl.replyToConversation);
router.post("/calls/:id/claim", ctrl.claimCall);

export default router;
