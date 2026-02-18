import express from "express";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import driverRequestController from "../controllers/driverRequest.controller";

const router = express.Router();

// Driver endpoints (auth required, no org required)
router.post("/", auth(), driverRequestController.createDriverRequest);
router.get(
  "/my-status",
  auth(),
  driverRequestController.getMyDriverRequestStatus,
);

// Admin endpoints (auth + org required, admin check in controller)
router.get(
  "/",
  auth(),
  requireOrg,
  driverRequestController.getDriverRequests,
);
router.patch(
  "/:id/approve",
  auth(),
  requireOrg,
  driverRequestController.approveDriverRequest,
);
router.patch(
  "/:id/reject",
  auth(),
  requireOrg,
  driverRequestController.rejectDriverRequest,
);

export default router;
