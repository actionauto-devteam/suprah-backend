import express from 'express';
import dashboardController from '../controllers/dashboard.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

router.get('/metrics', auth(), requireOrg, dashboardController.getDashboardMetrics);
router.get('/leaderboard', auth(), requireOrg, dashboardController.getLeaderboard);

export default router;
