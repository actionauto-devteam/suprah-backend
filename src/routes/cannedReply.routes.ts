import express from "express";
import crmAuth from "../middleware/crmAuth.middleware";
import * as ctrl from "../controllers/cannedReply.controller";

const router = express.Router();

router.use(crmAuth());

router.get("/", ctrl.getCannedReplies);
router.post("/", ctrl.createCannedReply);
router.patch("/:id", ctrl.updateCannedReply);
router.delete("/:id", ctrl.deleteCannedReply);
router.post("/:id/use", ctrl.useCannedReply);

export default router;
