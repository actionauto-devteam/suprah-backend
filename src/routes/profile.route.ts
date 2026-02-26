import express from 'express';
import profileController from '../controllers/profile.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// All routes require authentication
router.use(auth());

// Get user profile
router.get('/', profileController.getProfile);

// Update user profile
router.patch('/', profileController.updateProfile);

// Update online status
router.patch('/online-status', profileController.updateOnlineStatus);

// Update personal information
router.patch('/personal-info', profileController.updatePersonalInfo);

// Update avatar/profile picture
router.patch('/avatar', profileController.updateAvatar);

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