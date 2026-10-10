import express from "express";
import notificationController from "../controllers/notification.controller";
import auth from "../middleware/auth.middleware";
import { requireSuperAdmin } from "../middleware/rbac.middleware";

const router = express.Router();

router.use(auth());

router.get("/", notificationController.getNotifications);

router.get("/unread-count", notificationController.getUnreadCount);

router.patch("/:id/read", notificationController.markAsRead);

router.patch("/read-all", notificationController.markAllAsRead);

router.delete("/:id", notificationController.deleteNotification);

router.delete("/read/all", notificationController.deleteAllRead);

router.post("/broadcast", notificationController.broadcastNotification);

// A testing tool the app itself never calls: only super admins may use it.
router.post("/create-test", requireSuperAdmin, notificationController.createTestNotification);

export default router;
