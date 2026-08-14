import express from "express";
import driverProfileController from "../controllers/driverProfile.controller";
import driverStatusChangeRequestController from "../controllers/driverStatusChangeRequest.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import {
  uploadDriverDocument,
  uploadDriverStatusRequestAttachments,
} from "../middleware/upload.middleware";
import {
  driverDocumentUploadLimiter,
  uploadLimiter,
} from "../middleware/rate-limit.middleware";

const router = express.Router();

router.use(auth());

router.get("/", driverProfileController.getProfile);
router.patch("/equipment", driverProfileController.updateEquipment);
router.patch("/compliance", driverProfileController.updateCompliance);
router.post("/documents", driverDocumentUploadLimiter, auth(), uploadDriverDocument, driverProfileController.uploadDocument);
router.delete("/documents/:documentId", driverProfileController.deleteDocument);
router.patch("/logistics", driverProfileController.updateLogistics);
router.patch("/identity-verification", driverProfileController.updateIdentityVerification);

// Driver Dispatch Status requests. These stay under /driver-profile so the
// existing mounted router handles both driver and dispatcher access without
// introducing another top-level route registration.
router.get(
  "/status-requests/my-current",
  driverStatusChangeRequestController.getMyCurrentRequest,
);
router.post(
  "/status-requests",
  uploadLimiter,
  uploadDriverStatusRequestAttachments,
  driverStatusChangeRequestController.createRequest,
);
router.patch(
  "/status-requests/:requestId/details",
  uploadLimiter,
  uploadDriverStatusRequestAttachments,
  driverStatusChangeRequestController.updateRequestDetails,
);
router.post(
  "/status-requests/:requestId/cancel",
  driverStatusChangeRequestController.cancelRequest,
);

router.get(
  "/status-requests/org",
  requireOrg,
  driverStatusChangeRequestController.getOrganizationRequests,
);
router.get(
  "/status-requests/:requestId",
  requireOrg,
  driverStatusChangeRequestController.getRequestById,
);
router.post(
  "/status-requests/:requestId/approve",
  requireOrg,
  driverStatusChangeRequestController.approveRequest,
);
router.post(
  "/status-requests/:requestId/reject",
  requireOrg,
  driverStatusChangeRequestController.rejectRequest,
);

router.get("/org", requireOrg, driverProfileController.getOrgDriverProfiles);
router.get("/org/:driverId", requireOrg, driverProfileController.getDriverProfileById);
router.patch("/org/:driverId/approve", requireOrg, driverProfileController.approveDriverProfile);
router.patch("/org/:driverId/documents/:documentId/verify", requireOrg, driverProfileController.verifyDocument);
router.patch("/org/:driverId/documents/:documentId/reject", requireOrg, driverProfileController.rejectDocument);

export default router;