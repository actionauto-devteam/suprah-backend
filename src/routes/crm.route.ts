import express from 'express';
import crmController from '../controllers/crm.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

// ========================
// Public routes (no auth)
// ========================
router.post('/login', crmController.login);
router.post('/logout', crmController.logout);

// ========================
// Protected routes
// ========================
router.use(crmAuth());

router.get('/me', crmController.getMe);
router.post('/time-clock', crmController.timeClock);
router.get('/time-logs', crmController.getTimeLogs);

export default router;