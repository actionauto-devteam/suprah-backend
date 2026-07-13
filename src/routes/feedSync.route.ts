import express from "express";
import feedSyncController from "../controllers/feedsync.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";

const router = express.Router();


router.post(
  "/:feedId/ingest",
  express.text({ type: "*/*", limit: "25mb" }),
  feedSyncController.ingestPushedFeed,
);

router.use(auth());
router.use(requireOrg);

router.post("/", feedSyncController.createFeedConfig);
router.get("/", feedSyncController.listFeedConfigs);
router.put("/:feedId", feedSyncController.updateFeedConfig);
router.post("/:feedId/sync", feedSyncController.triggerSync);
router.post("/sync-all", feedSyncController.triggerSyncAll);

export default router;