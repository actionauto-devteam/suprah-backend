import express from "express";
import appointmentDashboardController from "../controllers/appointmentDashboard.controller";
import crmAuth from "../middleware/crmAuth.middleware";
import { requireOrg } from "../middleware/org.middleware";
import chatRoutes from "./chat.routes";
import communicationRoutes from "./communication.routes";
import vehicleHistoryRoutes from "./vehicleHistory.routes";

const router = express.Router();

// All dashboard routes require CRM authentication and organization context.
// (Nested chat + vehicle-history routers below inherit this middleware.)
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

// NEW: admins can delete their own announcement/update posts.
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

// NEW: real-time chat (REST persistence + Socket.IO broadcast).
router.use("/chat", chatRoutes);

// NEW: CRM communication module (SMS + inbound/outbound call logs).
router.use("/communications", communicationRoutes);

// NEW: vehicle history (test-drive / sold status per vehicle).
router.use("/vehicle-history", vehicleHistoryRoutes);

export default router;
