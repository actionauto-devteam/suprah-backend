import express from "express";
import type {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
} from "express";
// This router serves both dispatchers (staff) and drivers, both of whom are
// regular User-model accounts authenticated through the main JWT, not CrmUser
// records. It therefore uses auth(), which sets req.user and req.orgId.
import auth from "../middleware/auth.middleware";
import driverTrackingController from "../controllers/driverTracking.controller";
import loadController from "../controllers/load.controller";
import driverDirectoryController from "../controllers/driverDirectory.controller";
import dispatchChatController from "../controllers/dispatchChat.controller";
import { ApiError } from "../utils/ApiError";
import { uploadProofImage, validateUploadedImageContent } from "../middleware/upload.middleware";
import { uploadLimiter } from "../middleware/rate-limit.middleware";
import { startDriverLocationMonitor } from "../services/driverLocationMonitor.service";
import { uploadDispatchChatFiles } from "../middleware/dispatchChatAttachment.middleware";
import { startLoadLifecycleOutboxWorker } from "../services/loadLifecycleOutbox.service";

const STAFF_ROLES = ["employee", "admin", "super_admin"];
const staffOnly = (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
  const role = req.user?.role;
  if (role && STAFF_ROLES.includes(role)) return next();
  return res
    .status(403)
    .json({
      success: false,
      code: 403,
      message:
        "Driver Tracker management is restricted to authorized staff for the current organization.",
    });
};

const driverOnly = (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
  if (req.user?.role === "driver") return next();
  return res
    .status(403)
    .json({
      success: false,
      code: 403,
      message:
        "This Driver Portal action is available only to the signed-in driver account.",
    });
};

const noStoreSensitive = (_req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  return next();
};

const router = express.Router();

// Driver Tracker uses the main User identity for both staff and drivers.
// Everything below requires an authenticated organization member.
router.use(auth());

// Directory / map
router.get("/org-drivers", staffOnly, noStoreSensitive, driverDirectoryController.getOrgDrivers);
router.get("/active-drivers", staffOnly, noStoreSensitive, driverTrackingController.getActiveDrivers);
router.post("/heartbeat", driverOnly, driverTrackingController.heartbeat);
router.post(
  "/location-offline",
  driverOnly,
  driverTrackingController.markLocationOffline,
);

// Dispatcher load actions
router.post("/assign-load", staffOnly, driverTrackingController.assignLoad);
router.post(
  "/compatibility-preview",
  staffOnly,
  driverTrackingController.previewDriverLoadCompatibility,
);
router.post("/reassign-load", staffOnly, driverTrackingController.reassignLoad);
router.post("/remove-load", staffOnly, driverTrackingController.removeLoad);
router.get("/load-requests", staffOnly, driverTrackingController.getPendingLoadRequests);

// Dispatcher alert actions
router.post(
  "/drivers/:driverId/alert",
  staffOnly,
  driverTrackingController.sendDriverAlert,
);
router.get(
  "/drivers/:driverId/profile",
  staffOnly,
  noStoreSensitive,
  driverTrackingController.getDriverComplianceProfile,
);
router.get(
  "/drivers/:driverId/documents/:documentId/file",
  staffOnly,
  noStoreSensitive,
  driverTrackingController.getDriverReviewDocumentFile,
);
router.patch(
  "/drivers/:driverId/documents/:documentId/approve",
  staffOnly,
  noStoreSensitive,
  driverTrackingController.approveDriverReviewDocument,
);
router.patch(
  "/drivers/:driverId/documents/:documentId/reject",
  staffOnly,
  noStoreSensitive,
  driverTrackingController.rejectDriverReviewDocument,
);
router.patch(
  "/drivers/:driverId/approve",
  staffOnly,
  noStoreSensitive,
  driverTrackingController.approveDriverReview,
);
router.post(
  "/alerts/:alertId/respond",
  driverOnly,
  driverTrackingController.respondToDriverAlert,
);

router.use("/dispatch-chat", noStoreSensitive);

// Suprah Dispatch Chat — isolated from Suprah Space and private per exact
// dispatcher↔driver pair. The controller enforces the participant boundary on
// every history, unread, send, attachment, and read operation.
router.post(
  "/dispatch-chat/load/:loadId/open",
  driverOnly,
  dispatchChatController.openLoadCreatorThread,
);
router.get(
  "/dispatch-chat/threads",
  dispatchChatController.getThreads,
);
router.get(
  "/dispatch-chat/unread-total",
  dispatchChatController.getUnreadTotal,
);
router.get(
  "/dispatch-chat/:driverId/messages",
  dispatchChatController.getMessages,
);
router.get(
  "/dispatch-chat/:driverId/unread",
  dispatchChatController.getUnreadCount,
);
router.post(
  "/dispatch-chat/:driverId/messages",
  dispatchChatController.sendMessage,
);
router.post(
  "/dispatch-chat/:driverId/attachments",
  uploadDispatchChatFiles,
  dispatchChatController.uploadAttachments,
);
router.post(
  "/dispatch-chat/:driverId/read",
  dispatchChatController.markRead,
);

// Driver dashboard summary (read-only)
router.get("/dashboard-stats", driverOnly, noStoreSensitive, driverTrackingController.getDashboardStats);

// Driver load lists
router.get("/my-loads", driverOnly, noStoreSensitive, driverTrackingController.getMyLoads);
router.get("/my-requests", driverOnly, noStoreSensitive, driverTrackingController.getMyRequests);
router.get("/available-loads", driverOnly, noStoreSensitive, driverTrackingController.getAvailableLoads);

router.get("/loads/:id", driverOnly, noStoreSensitive, driverTrackingController.getLoadDetail);
router.post("/loads/:id/request", driverOnly, driverTrackingController.requestLoad);
router.post(
  "/loads/:id/approve-request",
  staffOnly,
  driverTrackingController.approveLoadRequest,
);
router.post(
  "/loads/:id/reject-request",
  staffOnly,
  driverTrackingController.rejectLoadRequest,
);

router.post("/loads/:id/accept", driverOnly, driverTrackingController.acceptLoad);
router.post(
  "/loads/:id/amendments/:amendmentId/acknowledge",
  driverOnly,
  noStoreSensitive,
  driverTrackingController.acknowledgeLoadAmendment,
);
router.post("/loads/:id/pickup", driverOnly, driverTrackingController.markPickedUp);
router.post("/loads/:id/start-route", driverOnly, driverTrackingController.startRoute);
router.post(
  "/loads/:id/submit-proof",
  driverOnly,
  noStoreSensitive,
  uploadLimiter,
  uploadProofImage,
  validateUploadedImageContent,
  loadController.submitProofOfDelivery,
);
router.post("/loads/:id/deliver", driverOnly, driverTrackingController.completeDelivery);
router.post(
  "/loads/:id/release-request",
  driverOnly,
  driverTrackingController.requestLoadRelease,
);
router.post(
  "/loads/:id/release-request/cancel",
  driverOnly,
  driverTrackingController.cancelReleaseRequest,
);
router.post(
  "/loads/:id/release-request/reject",
  staffOnly,
  driverTrackingController.rejectReleaseRequest,
);
// Backward-compatible alias: /drop now creates a release request and never
// directly changes assignment/status.
router.post("/loads/:id/drop", driverOnly, driverTrackingController.dropLoad);

// Start the organization-wide location-silence monitor once when Driver
// Tracking routes are initialized. The service internally guards against
// duplicate timers.
startDriverLocationMonitor();
startLoadLifecycleOutboxWorker();

export default router;