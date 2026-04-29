import express from "express";
import driverTrackingController from "../controllers/driverTracking.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";

const router = express.Router();

router.use(auth());

// Driver routes — no org required (drivers are not in Clerk orgs)
router.post("/location", driverTrackingController.updateLocation);
router.get("/my-loads", driverTrackingController.getMyLoads);
router.post("/accept-load", driverTrackingController.acceptLoad);
router.post("/mark-picked-up", driverTrackingController.markPickedUp);
router.post("/drop-load", driverTrackingController.dropLoad);
router.post("/start-route", driverTrackingController.startRoute);
router.get("/available-loads", driverTrackingController.getAvailableLoads);
router.post("/request-load", driverTrackingController.requestLoad);
router.get("/my-requests", driverTrackingController.getMyRequests);
router.get(
  "/dashboard-stats",
  driverTrackingController.getDriverDashboardStats,
);

router.use(requireOrg);
router.get("/active", driverTrackingController.getActiveDrivers);
router.post("/assign-load", driverTrackingController.assignLoad);
router.post("/remove-load", driverTrackingController.removeLoad);
router.post("/reassign-load", driverTrackingController.reassignLoad);
router.get("/load-requests", driverTrackingController.getLoadRequests);
router.post("/approve-request", driverTrackingController.approveLoadRequest);
router.post("/reject-request", driverTrackingController.rejectLoadRequest);

export default router;
