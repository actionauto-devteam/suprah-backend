import express from "express";
import auth from "../middleware/auth.middleware";
import authorize from "../middleware/role.middleware";
import driverRequestController from "../controllers/driverRequest.controller";

const router = express.Router();

// Driver endpoints (auth required, any role can apply to be a driver)
router.post("/", auth(), driverRequestController.createDriverRequest);
router.get(
  "/my-status",
  auth(),
  driverRequestController.getMyDriverRequestStatus,
);

// Admin-only endpoints (Strictly super_admin or admin)
router.get("/", auth(), authorize(['super_admin', 'admin']), driverRequestController.getDriverRequests);
router.patch(
  "/:id/approve",
  auth(),
  authorize(['super_admin', 'admin']),
  driverRequestController.approveDriverRequest,
);
router.patch(
  "/:id/reject",
  auth(),
  authorize(['super_admin', 'admin']),
  driverRequestController.rejectDriverRequest,
);

export default router;
