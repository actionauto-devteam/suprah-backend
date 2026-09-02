import express from "express";
import driverProfileController from "../controllers/driverProfile.controller";
import driverStatusChangeRequestController from "../controllers/driverStatusChangeRequest.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import authorize from "../middleware/role.middleware";
import {
  uploadDriverDocument,
  uploadDriverStatusRequestAttachments,
  validateDriverDocumentContent,
  validateDriverStatusRequestAttachmentContent,
} from "../middleware/upload.middleware";
import {
  driverDocumentUploadLimiter,
  uploadLimiter,
} from "../middleware/rate-limit.middleware";

const router = express.Router();

router.use(auth());

const driverOnly = authorize("driver");
const staffOnly = authorize(["super_admin", "admin", "employee"]);

router.get("/", driverOnly, driverProfileController.getProfile);
router.patch("/equipment", driverOnly, driverProfileController.updateEquipment);
router.patch("/personal-info", driverOnly, driverProfileController.updatePersonalInfo);
router.patch("/compliance", driverOnly, driverProfileController.updateCompliance);
router.post(
  "/documents",
  driverOnly,
  driverDocumentUploadLimiter,
  uploadDriverDocument,
  validateDriverDocumentContent,
  driverProfileController.uploadDocument,
);

router.get(
  "/documents/:documentId/file",
  driverOnly,
  driverProfileController.getDocumentFile,
);

router.post(
  "/documents/:documentId/replace",
  driverOnly,
  driverDocumentUploadLimiter,
  uploadDriverDocument,
  validateDriverDocumentContent,
  driverProfileController.replaceDocument,
);

router.delete(
  "/documents/:documentId",
  driverOnly,
  driverProfileController.deleteDocument,
);
router.patch("/logistics", driverOnly, driverProfileController.updateLogistics);
router.patch(
  "/identity-verification",
  driverOnly,
  driverProfileController.updateIdentityVerification,
);

// Driver Dispatch Status requests.
router.get(
  "/status-requests/my-current",
  driverOnly,
  driverStatusChangeRequestController.getMyCurrentRequest,
);
router.post(
  "/status-requests",
  driverOnly,
  uploadLimiter,
  uploadDriverStatusRequestAttachments,
  validateDriverStatusRequestAttachmentContent,
  driverStatusChangeRequestController.createRequest,
);
router.patch(
  "/status-requests/:requestId/details",
  driverOnly,
  uploadLimiter,
  uploadDriverStatusRequestAttachments,
  validateDriverStatusRequestAttachmentContent,
  driverStatusChangeRequestController.updateRequestDetails,
);
router.post(
  "/status-requests/:requestId/cancel",
  driverOnly,
  driverStatusChangeRequestController.cancelRequest,
);

router.get(
  "/status-requests/org",
  requireOrg,
  staffOnly,
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
  staffOnly,
  driverStatusChangeRequestController.approveRequest,
);
router.post(
  "/status-requests/:requestId/reject",
  requireOrg,
  staffOnly,
  driverStatusChangeRequestController.rejectRequest,
);

export default router;