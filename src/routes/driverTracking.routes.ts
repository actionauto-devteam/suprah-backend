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
router.post("/drop-load", driverTrackingController.dropLoad);

router.use(requireOrg);
router.get("/active", driverTrackingController.getActiveDrivers);
router.post("/assign-load", driverTrackingController.assignLoad);
router.post("/remove-load", driverTrackingController.removeLoad);
router.post("/reassign-load", driverTrackingController.reassignLoad);

export default router;
