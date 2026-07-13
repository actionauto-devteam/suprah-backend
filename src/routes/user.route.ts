import express from 'express';
import userController from '../controllers/user.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.use(auth());

router.get('/search', userController.searchUsers);

router.get('/me', userController.getProfile);
router.get('/me/organizations', userController.getUserOrganizations);
router.post('/me/select-org', userController.selectOrganization);
router.post('/me/join-org', userController.joinOnboardingOrg);
router.post('/me/complete-onboarding', userController.completeOnboarding);

router.get('/profile/:id?', userController.getProfile);

router.patch('/profile', userController.updateProfile);

export default router;