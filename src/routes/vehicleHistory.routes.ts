import express from "express";
import vehicleHistoryController from "../controllers/vehicleHistory.controller";

const router = express.Router();

router.get("/", vehicleHistoryController.getVehicleHistory);

export default router;