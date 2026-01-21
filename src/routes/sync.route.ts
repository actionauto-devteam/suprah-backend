import express from 'express';
import syncController from '../controllers/sync.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// Protected routes (admin/manager should trigger sync)
router.post('/trigger', auth(), syncController.triggerSync);
router.get('/status', auth(), syncController.getSyncStatus);

export default router;
