import express from 'express';
import syncController from '../controllers/sync.controller';
import auth from '../middleware/auth.middleware';
import { inventorySyncLimiter } from '../middleware/rate-limit.middleware';

const router = express.Router();

// Protected routes (admin/manager should trigger sync)
router.post('/trigger', inventorySyncLimiter, auth(), syncController.triggerSync);
router.get('/status', auth(), syncController.getSyncStatus);

export default router;
