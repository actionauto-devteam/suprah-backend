import express from "express";
import loadController from "../controllers/load.controller";
import auth from "../middleware/auth.middleware";
import { requireOrg } from "../middleware/org.middleware";

const router = express.Router();

router.use(auth());
router.use(requireOrg);

router
  .route("/")
  .post(loadController.createLoad)
  .get(loadController.getLoads);

router
  .route("/:id")
  .get(loadController.getLoadById);

export default router;
