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

// Admin routes — org required
router.use(requireOrg);
router.get("/active", driverTrackingController.getActiveDrivers);
router.post("/assign-load", driverTrackingController.assignLoad);

export default router;
