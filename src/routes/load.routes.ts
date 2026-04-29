import express from "express";
import loadController from "../controllers/load.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import authorize from "../middleware/role.middleware";
import { uploadProofImage } from "../middleware/upload.middleware";
import { uploadLimiter } from "../middleware/rate-limit.middleware";

const router = express.Router();

router.use(auth());
router.use(requireOrg);

// ── Admin/employee-only routes (drivers have no reason to access these) ───────
const staffOnly = authorize(["super_admin", "admin", "employee"]);

router.get("/vin/:vin", staffOnly, loadController.lookupVin);
router.get("/vehicles", staffOnly, loadController.getInventoryVehicles);
router.post("/calculate-rate", staffOnly, loadController.calculateLoadRate);

// ── Stats — all authenticated org members ─────────────────────────────────────
router.get("/stats", loadController.getLoadStats);

// ── CRUD ──────────────────────────────────────────────────────────────────────
router
  .route("/")
  .post(staffOnly, loadController.createLoad)   // drivers cannot create loads
  .get(loadController.getLoads);                // drivers can read (masking applied in controller)

router
  .route("/:id")
  .get(loadController.getLoadById)              // drivers can read (masking applied in controller)
  .put(staffOnly, loadController.updateLoad)    // staff only
  .delete(staffOnly, loadController.deleteLoad); // staff only

// Internal notes — staff only
router.post("/:id/notes", staffOnly, loadController.addNote);

// Send load details by email — staff only
router.post("/:id/send-email", staffOnly, loadController.sendDetailsEmail);

// Driver submits proof — drivers pass requireOrg via their organizationId from the DB
router.post("/:id/submit-proof", uploadLimiter, uploadProofImage, loadController.submitProofOfDelivery);

// Admin/dealer streams proof image (proxy — avoids exposing private R2 keys)
router.get("/:id/proof-image", staffOnly, loadController.streamProofImage);

// Admin/dealer confirms proof of delivery
router.post("/:id/confirm-delivery", staffOnly, loadController.confirmDelivery);

export default router;
