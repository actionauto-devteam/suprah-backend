import express from "express";
import loadController from "../controllers/load.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import authorize from "../middleware/role.middleware";

const router = express.Router();

router.use(auth());
router.use(requireOrg);

// ── Admin/employee-only routes (drivers have no reason to access these) ───────
const staffOnly = authorize(["super_admin", "admin", "employee"]);

router.get("/vin/:vin",        staffOnly, loadController.lookupVin);
router.get("/vehicles",        staffOnly, loadController.getInventoryVehicles);
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
  .get(loadController.getLoadById);             // drivers can read (masking applied in controller)

export default router;
