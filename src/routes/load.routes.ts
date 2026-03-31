import express from "express";
import loadController from "../controllers/load.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";

const router = express.Router();

router.use(auth());
router.use(requireOrg);

// Static routes first — must be before /:id to avoid param conflicts
router.get("/vin/:vin",         loadController.lookupVin);
router.get("/vehicles",         loadController.getInventoryVehicles);
router.get("/stats",            loadController.getLoadStats);
router.post("/calculate-rate",  loadController.calculateLoadRate);

// CRUD
router
  .route("/")
  .post(loadController.createLoad)
  .get(loadController.getLoads);

router
  .route("/:id")
  .get(loadController.getLoadById);

export default router;
