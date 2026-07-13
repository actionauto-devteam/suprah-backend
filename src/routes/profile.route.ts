import express from 'express';
import profileController from '../controllers/profile.controller';
import auth from '../middleware/auth.middleware';
import { uploadAvatarImage } from '../middleware/upload.middleware';
import { uploadLimiter } from '../middleware/rate-limit.middleware';

const router = express.Router();

router.patch('/avatar', uploadLimiter, auth(), uploadAvatarImage, profileController.updateAvatar);

router.use(auth());

router.get('/', profileController.getProfile);

router.patch('/', profileController.updateProfile);

router.patch('/online-status', profileController.updateOnlineStatus);

router.patch('/personal-info', profileController.updatePersonalInfo);

router.delete('/avatar', profileController.removeAvatar);

router.get('/driver-stats', profileController.getDriverStats);

router.get('/activities', profileController.getRecentActivities);

router.post('/change-password', profileController.changePassword);

router.patch('/email', profileController.updateEmail);

router.patch('/notification-preferences', profileController.updateNotificationPreferences);

router.patch('/theme', profileController.updateTheme);

router.patch('/heartbeat', profileController.heartbeat);

export default router;