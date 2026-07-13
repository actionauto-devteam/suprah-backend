import express from "express";
import appointmentDashboardController from "../controllers/appointmentDashboard.controller";
import crmAuth from "../middleware/crmAuth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import chatRoutes from "./chat.routes";
import communicationRoutes from "./communication.routes";
import vehicleHistoryRoutes from "./vehicleHistory.routes";

const router = express.Router();

router.use(crmAuth());
router.use(requireOrg);

router.get("/", appointmentDashboardController.getAppointmentsDashboard);

router.get(
  "/posts",
  appointmentDashboardController.getAppointmentDashboardPosts,
);

router.post(
  "/posts",
  appointmentDashboardController.createAppointmentDashboardPost,
);

router.delete(
  "/posts/:id",
  appointmentDashboardController.deleteAppointmentDashboardPost,
);

router.get(
  "/stats",
  appointmentDashboardController.getAppointmentsDashboardStats,
);

router.get(
  "/export",
  appointmentDashboardController.exportAppointmentsDashboard,
);

router.use("/chat", chatRoutes);

router.use("/communications", communicationRoutes);

router.use("/vehicle-history", vehicleHistoryRoutes);

export default router;
