import express from "express";
import loadController from "../controllers/load.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import authorize from "../middleware/role.middleware";
import { uploadProofImage, validateUploadedImageContent } from "../middleware/upload.middleware";
import { uploadLimiter } from "../middleware/rate-limit.middleware";

const router = express.Router();

router.use(auth());
router.use(requireOrg);
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

const staffOnly = authorize(["super_admin", "admin", "employee"]);

router.get("/vin/:vin", staffOnly, loadController.lookupVin);
router.get("/vehicles", staffOnly, loadController.getInventoryVehicles);
router.post("/calculate-rate", staffOnly, loadController.calculateLoadRate);

router.get("/stats", staffOnly, loadController.getLoadStats);

router
  .route("/")
  .post(staffOnly, loadController.createLoad)
  .get(staffOnly, loadController.getLoads);

router
  .route("/:id")
  .get(staffOnly, loadController.getLoadById)
  .put(staffOnly, loadController.updateLoad)
  .delete(staffOnly, loadController.deleteLoad);

router.post("/:id/notes", staffOnly, loadController.addNote);

router.post("/:id/send-email", staffOnly, loadController.sendDetailsEmail);

router.post("/:id/submit-proof", uploadLimiter, uploadProofImage, validateUploadedImageContent, loadController.submitProofOfDelivery);

router.post("/:id/vehicles/:index/inspection-photo", staffOnly, uploadLimiter, uploadProofImage, validateUploadedImageContent, loadController.uploadInspectionPhoto);

router.get("/:id/proof-image", staffOnly, loadController.streamProofImage);

router.post("/:id/confirm-delivery", staffOnly, loadController.confirmDelivery);

export default router;