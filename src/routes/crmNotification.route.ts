import express from 'express';
import crmNotificationController from '../controllers/crmNotification.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

router.use(crmAuth());

router.get('/', crmNotificationController.getNotifications);
router.get('/unread-count', crmNotificationController.getUnreadCount);
router.get('/preferences', crmNotificationController.getPreferences);
router.patch('/preferences', crmNotificationController.updatePreferences);
router.patch('/:id/read', crmNotificationController.markAsRead);
router.patch('/read-all', crmNotificationController.markAllAsRead);
router.delete('/:id', crmNotificationController.deleteNotification);
router.delete('/read/all', crmNotificationController.deleteAllRead);

export default router;
