import express from 'express';
import userController from '../controllers/user.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// All user routes require authentication
router.use(auth());

// Search users
router.get('/search', userController.searchUsers);

// Get user profile
router.get('/profile/:id?', userController.getProfile);

// Update user profile
router.patch('/profile', userController.updateProfile);

export default router;