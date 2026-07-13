import express from "express";
import notificationController from "../controllers/notification.controller";
import auth from "../middleware/auth.middleware";

const router = express.Router();

router.use(auth());

router.get("/", notificationController.getNotifications);

router.get("/unread-count", notificationController.getUnreadCount);

router.patch("/:id/read", notificationController.markAsRead);

router.patch("/read-all", notificationController.markAllAsRead);

router.delete("/:id", notificationController.deleteNotification);

router.delete("/read/all", notificationController.deleteAllRead);

router.post("/broadcast", notificationController.broadcastNotification);

router.post("/create-test", notificationController.createTestNotification);

export default router;
