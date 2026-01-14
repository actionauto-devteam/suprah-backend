import express from 'express';
import validate from '../middleware/validate.middleware';
import authValidation from '../validations/auth.validation';
import authController from '../controllers/auth.controller';
import auth from '../middleware/auth.middleware';
import authorize from '../middleware/role.middleware';

const router = express.Router();

router.post('/register', validate(authValidation.register), authController.register);
router.post('/login', validate(authValidation.login), authController.login);
router.post('/logout', authController.logout);
router.post('/refresh', validate(authValidation.refreshTokens), authController.refreshTokens);
router.get('/me', auth(), authorize('user'), authController.getMe);
router.get('/admin', auth(), authorize('admin'), (req, res) => res.send('Admin content'));

export default router;
