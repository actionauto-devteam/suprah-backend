import express from "express";
import feedSyncController from "../controllers/feedsync.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";

const router = express.Router();

/**
 * Mount this under "/sync" in routes/index.ts, e.g.:
 *   import feedSyncRoute from "./feedSync.route";
 *   { path: "/sync/feeds", route: feedSyncRoute }
 *
 * The "push" ingest endpoint is intentionally left UNAUTHENTICATED-by-default
 * below so an external system can POST to it — secure it with a shared secret
 * header or signed token before going live (see note in the README).
 */

// --- Push ingest (external caller hands you the file body) ---
// IMPORTANT: protect this with a secret before production.
router.post(
  "/:feedId/ingest",
  express.text({ type: "*/*", limit: "25mb" }),
  feedSyncController.ingestPushedFeed,
);

// --- Authenticated admin/management routes ---
router.use(auth());
router.use(requireOrg);

router.post("/", feedSyncController.createFeedConfig);
router.get("/", feedSyncController.listFeedConfigs);
router.put("/:feedId", feedSyncController.updateFeedConfig);
router.post("/:feedId/sync", feedSyncController.triggerSync);
router.post("/sync-all", feedSyncController.triggerSyncAll);

export default router;