import express from "express";
import driverProfileController from "../controllers/driverProfile.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import { uploadDriverDocument } from "../middleware/upload.middleware";

const router = express.Router();

router.use(auth());

router.get("/", driverProfileController.getProfile);
router.patch("/equipment", driverProfileController.updateEquipment);
router.patch("/compliance", driverProfileController.updateCompliance);
router.post("/documents", uploadDriverDocument, driverProfileController.uploadDocument);
router.delete("/documents/:documentId", driverProfileController.deleteDocument);
router.patch("/logistics", driverProfileController.updateLogistics);

router.get("/org", requireOrg, driverProfileController.getOrgDriverProfiles);
router.get("/org/:driverId", requireOrg, driverProfileController.getDriverProfileById);

export default router;
