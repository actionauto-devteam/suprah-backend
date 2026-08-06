import { Router, Request, Response, NextFunction } from "express";
// crmAuth is the middleware module's DEFAULT export (TS2614 confirmed no
// named exports). If your middleware is a factory used as crmAuth()
// elsewhere in routes, change the router.use line below to crmAuth().
import crmAuth from "../middleware/crmAuth.middleware";

// Local staff guard — the middleware exports no staffOnly, so the role
// gate lives here, using the platform's real role names from User.model
// (customer | employee | admin | super_admin | driver).
const STAFF_ROLES = ["employee", "admin", "super_admin"];
const staffOnly = (req: Request, res: Response, next: NextFunction) => {
  const role = (req as any).user?.role;
  if (role && STAFF_ROLES.includes(role)) return next();
  return res
    .status(403)
    .json({ success: false, message: "Staff access required" });
};
import driverTrackingController from "../controllers/driverTracking.controller";
import driverDirectoryController from "../controllers/driverDirectory.controller";

const router = Router();

// Everything below requires an authenticated org member
router.use(crmAuth);

// ─── Static routes FIRST (before any /:id) — codebase convention ─────────────

// Centralized driver directory — the single source of truth for
// "who are the drivers in this org". Consumed by Create Load's Assign
// Driver picker, the Driver Tracker, and the Transportation page.
router.get("/org-drivers", staffOnly, driverDirectoryController.getOrgDrivers);

// Live map data
router.get("/active-drivers", staffOnly, driverTrackingController.getActiveDrivers);

// Driver location heartbeat
router.post("/heartbeat", driverTrackingController.heartbeat);

// Dispatcher assignment actions
router.post("/assign-load", staffOnly, driverTrackingController.assignLoad);
router.post("/reassign-load", staffOnly, driverTrackingController.reassignLoad);
router.post("/remove-load", staffOnly, driverTrackingController.removeLoad);

// Driver's Account load lists
router.get("/my-loads", driverTrackingController.getMyLoads);
router.get("/available-loads", driverTrackingController.getAvailableLoads);

// ─── Parameterized routes ────────────────────────────────────────────────────

router.get("/loads/:id", driverTrackingController.getLoadDetail);

// Available-load request / approval flow
router.post("/loads/:id/request", driverTrackingController.requestLoad);
router.post("/loads/:id/approve-request", staffOnly, driverTrackingController.approveLoadRequest);
router.post("/loads/:id/reject-request", staffOnly, driverTrackingController.rejectLoadRequest);

// Driver status transitions
router.post("/loads/:id/accept", driverTrackingController.acceptLoad);
router.post("/loads/:id/pickup", driverTrackingController.markPickedUp);
router.post("/loads/:id/start-route", driverTrackingController.startRoute);
router.post("/loads/:id/drop", driverTrackingController.dropLoad);

export default router;