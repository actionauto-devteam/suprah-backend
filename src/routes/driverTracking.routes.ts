import { Router, Request, Response, NextFunction, RequestHandler } from "express";
import multer from "multer";
// c
// This router serves both dispatchers (staff) and drivers, both of whom are
// regular User-model accounts authenticated through the main JWT, not CrmUser
// records. It therefore uses auth(), which sets req.user and req.orgId.
import auth from "../middleware/auth.middleware";
import driverTrackingController from "../controllers/driverTracking.controller";
import driverDirectoryController from "../controllers/driverDirectory.controller";
import dispatchChatController from "../controllers/dispatchChat.controller";
import { ApiError } from "../utils/ApiError";

const STAFF_ROLES = ["employee", "admin", "super_admin"];
const staffOnly = (req: Request, res: Response, next: NextFunction) => {
  const role = (req as any).user?.role;
  if (role && STAFF_ROLES.includes(role)) return next();
  return res
    .status(403)
    .json({ success: false, message: "Staff access required" });
};

const router = Router();

const DISPATCH_CHAT_MAX_FILES = 5;
const DISPATCH_CHAT_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const BLOCKED_ATTACHMENT_EXTENSIONS =
  /\.(exe|msi|bat|cmd|com|scr|ps1|vbs|jar)$/i;

const dispatchChatUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: DISPATCH_CHAT_MAX_FILES,
    fileSize: DISPATCH_CHAT_MAX_FILE_SIZE_BYTES,
  },
});

const uploadDispatchChatFiles: RequestHandler = (req, res, next) => {
  dispatchChatUpload.array("files", DISPATCH_CHAT_MAX_FILES)(
    req,
    res,
    (error: any) => {
      if (error instanceof multer.MulterError) {
        if (error.code === "LIMIT_FILE_SIZE") {
          return next(
            new ApiError(
              400,
              "Each Dispatch Chat attachment must be 25 MB or smaller",
            ),
          );
        }
        if (error.code === "LIMIT_FILE_COUNT") {
          return next(
            new ApiError(
              400,
              `You can attach up to ${DISPATCH_CHAT_MAX_FILES} files at once`,
            ),
          );
        }
        return next(new ApiError(400, error.message));
      }

      if (error) {
        return next(
          new ApiError(400, error.message || "Failed to process attachment"),
        );
      }

      const files = (req.files || []) as Express.Multer.File[];
      const blocked = files.find((file) =>
        BLOCKED_ATTACHMENT_EXTENSIONS.test(file.originalname || ""),
      );
      if (blocked) {
        return next(
          new ApiError(
            400,
            `${blocked.originalname} is not an allowed Dispatch Chat attachment`,
          ),
        );
      }

      return next();
    },
  );
};


// Driver Tracker uses the main User identity for both staff and drivers.
// Everything below requires an authenticated organization member.
router.use(auth());

// Directory / map
router.get("/org-drivers", staffOnly, driverDirectoryController.getOrgDrivers);
router.get("/active-drivers", staffOnly, driverTrackingController.getActiveDrivers);
router.post("/heartbeat", driverTrackingController.heartbeat);

// Dispatcher load actions
router.post("/assign-load", staffOnly, driverTrackingController.assignLoad);
router.post("/reassign-load", staffOnly, driverTrackingController.reassignLoad);
router.post("/remove-load", staffOnly, driverTrackingController.removeLoad);
router.get("/load-requests", staffOnly, driverTrackingController.getPendingLoadRequests);

// Dispatcher alert actions
router.post(
  "/drivers/:driverId/alert",
  staffOnly,
  driverTrackingController.sendDriverAlert,
);
router.post(
  "/alerts/:alertId/respond",
  driverTrackingController.respondToDriverAlert,
);

// Suprah Dispatch Chat — isolated from Suprah Space.
// Access is enforced again inside the controller:
//   driver -> own thread only
//   staff  -> drivers in the same organization only
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
router.get("/dashboard-stats", driverTrackingController.getDashboardStats);

// Driver load lists
router.get("/my-loads", driverTrackingController.getMyLoads);
router.get("/my-requests", driverTrackingController.getMyRequests);
router.get("/available-loads", driverTrackingController.getAvailableLoads);

router.get("/loads/:id", driverTrackingController.getLoadDetail);
router.post("/loads/:id/request", driverTrackingController.requestLoad);
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

router.post("/loads/:id/accept", driverTrackingController.acceptLoad);
router.post("/loads/:id/pickup", driverTrackingController.markPickedUp);
router.post("/loads/:id/start-route", driverTrackingController.startRoute);
router.post("/loads/:id/drop", driverTrackingController.dropLoad);

export default router;