import express from "express";
import { telnyxWebhook } from "../controllers/communication.controller";

const router = express.Router();

router.post("/", telnyxWebhook);

export default router;
