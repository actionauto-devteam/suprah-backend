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

// Change password
router.post('/change-password', profileController.changePassword);

// Update email
router.patch('/email', profileController.updateEmail);

// Update notification preferences
router.patch('/notification-preferences', profileController.updateNotificationPreferences);

// Update theme
router.patch('/theme', profileController.updateTheme);

export default router;