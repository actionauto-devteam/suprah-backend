import express from "express";
import auth from "../middleware/auth.middleware";
import driverRequestController from "../controllers/driverRequest.controller";

const router = express.Router();

// Driver endpoints (auth required, no org required)
router.post("/", auth(), driverRequestController.createDriverRequest);
router.get(
  "/my-status",
  auth(),
  driverRequestController.getMyDriverRequestStatus,
);

// Super admin endpoints (auth required, role check in controller)
router.get("/", auth(), driverRequestController.getDriverRequests);
router.patch(
  "/:id/approve",
  auth(),
  driverRequestController.approveDriverRequest,
);
router.patch(
  "/:id/reject",
  auth(),
  driverRequestController.rejectDriverRequest,
);

export default router;
