import express from "express";
import appointmentDashboardController from "../controllers/appointmentDashboard.controller";
import crmAuth from "../middleware/crmAuth.middleware";
import { requireOrg } from "../middleware/org.middleware";

const router = express.Router();

// All dashboard routes require CRM authentication and organization context
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

router.get(
  "/stats",
  appointmentDashboardController.getAppointmentsDashboardStats,
);

router.get(
  "/export",
  appointmentDashboardController.exportAppointmentsDashboard,
);

export default router;
