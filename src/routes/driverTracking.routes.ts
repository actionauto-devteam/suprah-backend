import { Router, Request, Response, NextFunction } from "express";
// r
// This router serves both dispatchers (staff) and drivers, both of whom are
// regular User-model accounts authenticated through the main JWT, not CrmUser
// records. It therefore uses auth(), which sets req.user and req.orgId.
import auth from "../middleware/auth.middleware";
import driverTrackingController from "../controllers/driverTracking.controller";
import driverDirectoryController from "../controllers/driverDirectory.controller";

const STAFF_ROLES = ["employee", "admin", "super_admin"];
const staffOnly = (req: Request, res: Response, next: NextFunction) => {
  const role = (req as any).user?.role;
  if (role && STAFF_ROLES.includes(role)) return next();
  return res
    .status(403)
    .json({ success: false, message: "Staff access required" });
};

const router = Router();

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