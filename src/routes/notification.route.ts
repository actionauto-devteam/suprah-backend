import express from 'express';
import notificationController from '../controllers/notification.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// All routes require authentication
router.use(auth());
router.use(requireOrg);

// Get all notifications
router.get('/', notificationController.getNotifications);

// Get unread count
router.get('/unread-count', notificationController.getUnreadCount);

// Mark a notification as read
router.patch('/:id/read', notificationController.markAsRead);

// Mark all notifications as read
router.patch('/read-all', notificationController.markAllAsRead);

// Delete a notification
router.delete('/:id', notificationController.deleteNotification);

// Delete all read notifications
router.delete('/read/all', notificationController.deleteAllRead);

export default router;