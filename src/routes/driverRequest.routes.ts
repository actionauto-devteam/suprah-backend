import express from "express";
import auth from "../middleware/auth.middleware";
import { requireSuperAdmin } from "../middleware/rbac.middleware";
import driverRequestController from "../controllers/driverRequest.controller";

const router = express.Router();

// Driver self-service — any authenticated driver.
router.post("/", auth(), driverRequestController.createDriverRequest);
router.get(
  "/my-status",
  auth(),
  driverRequestController.getMyDriverRequestStatus,
);

// Admin review — drivers are a shared platform-wide pool, so only the
// SUPRAH.AI super_admin reviews/approves/rejects applications.
router.get("/", auth(), requireSuperAdmin, driverRequestController.getDriverRequests);
router.get(
  "/by-driver/:userId",
  auth(),
  requireSuperAdmin,
  driverRequestController.getDriverRequestByDriver,
);
router.patch(
  "/:id/approve",
  auth(),
  requireSuperAdmin,
  driverRequestController.approveDriverRequest,
);
router.patch(
  "/:id/reject",
  auth(),
  requireSuperAdmin,
  driverRequestController.rejectDriverRequest,
);

export default router;
