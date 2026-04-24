import express from 'express';
import profileController from '../controllers/profile.controller';
import auth from '../middleware/auth.middleware';
import { uploadAvatarImage } from '../middleware/upload.middleware';
import { uploadLimiter } from '../middleware/rate-limit.middleware';

const router = express.Router();

// Routes that DON'T need the global auth() first (we handle auth per route or before the limiter)
// Update avatar/profile picture (file upload)
// We put uploadLimiter FIRST to protect against unauthenticated flooding
router.patch('/avatar', uploadLimiter, auth(), uploadAvatarImage, profileController.updateAvatar);

// All other routes require authentication
router.use(auth());

// Get user profile
router.get('/', profileController.getProfile);

// Update user profile
router.patch('/', profileController.updateProfile);

// Update online status
router.patch('/online-status', profileController.updateOnlineStatus);

// Update personal information
router.patch('/personal-info', profileController.updatePersonalInfo);

// Remove avatar/profile picture
router.delete('/avatar', profileController.removeAvatar);

// Get driver stats
router.get('/driver-stats', profileController.getDriverStats);

// Get recent activities
router.get('/activities', profileController.getRecentActivities);

// Change password
router.post('/change-password', profileController.changePassword);

// Update email
router.patch('/email', profileController.updateEmail);

// Update notification preferences
router.patch('/notification-preferences', profileController.updateNotificationPreferences);

// Update theme
router.patch('/theme', profileController.updateTheme);

export default router;