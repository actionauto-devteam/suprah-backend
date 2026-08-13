import express from "express";
import driverProfileController from "../controllers/driverProfile.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import { uploadDriverDocument } from "../middleware/upload.middleware";
import { driverDocumentUploadLimiter } from "../middleware/rate-limit.middleware";

const router = express.Router();

router.use(auth());

router.get("/", driverProfileController.getProfile);
router.patch("/equipment", driverProfileController.updateEquipment);
router.patch("/compliance", driverProfileController.updateCompliance);
router.post("/documents", driverDocumentUploadLimiter, auth(), uploadDriverDocument, driverProfileController.uploadDocument);
router.delete("/documents/:documentId", driverProfileController.deleteDocument);
router.patch("/logistics", driverProfileController.updateLogistics);
router.patch("/identity-verification", driverProfileController.updateIdentityVerification);

router.get("/org", requireOrg, driverProfileController.getOrgDriverProfiles);
router.get("/org/:driverId", requireOrg, driverProfileController.getDriverProfileById);
router.patch("/org/:driverId/approve", requireOrg, driverProfileController.approveDriverProfile);
router.patch("/org/:driverId/documents/:documentId/verify", requireOrg, driverProfileController.verifyDocument);
router.patch("/org/:driverId/documents/:documentId/reject", requireOrg, driverProfileController.rejectDocument);

export default router;
