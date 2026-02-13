import express from "express";
import driverTrackingController from "../controllers/driverTracking.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";

const router = express.Router();

router.use(auth());
router.use(requireOrg);

router.get("/active", driverTrackingController.getActiveDrivers);
router.get("/my-loads", driverTrackingController.getMyLoads);
router.post("/location", driverTrackingController.updateLocation);
router.post("/assign-load", driverTrackingController.assignLoad);
router.post("/accept-load", driverTrackingController.acceptLoad);

export default router;
