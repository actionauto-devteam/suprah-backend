import express from "express";
import communicationController from "../controllers/communication.controller";

const router = express.Router();

router.get("/", communicationController.listLogs);
router.post("/sms", communicationController.sendSms);
router.post("/sms/inbound", communicationController.receiveInboundSms);
router.post("/calls", communicationController.logCall);

export default router;
