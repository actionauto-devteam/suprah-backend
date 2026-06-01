import express from 'express';
import userController from '../controllers/user.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// All user routes require authentication
router.use(auth());

// Search users
router.get('/search', userController.searchUsers);

// Current User Routes
router.get('/me', userController.getProfile);
router.get('/me/organizations', userController.getUserOrganizations);
router.post('/me/select-org', userController.selectOrganization);         // switch between orgs (must already be a member)
router.post('/me/join-org', userController.joinOnboardingOrg);            // ← new: onboarding step 2, joins org for the first time
router.post('/me/complete-onboarding', userController.completeOnboarding); // ← new: onboarding step 1, sets role

// Get user profile
router.get('/profile/:id?', userController.getProfile);

// Update user profile
router.patch('/profile', userController.updateProfile);

export default router;