import { Router } from 'express';
import analyticsController from '../controllers/analytics.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = Router();

router.use(crmAuth());

router.get('/leaderboard',         analyticsController.getLeaderboard);

router.get('/my-stats',            analyticsController.getMyStats);

router.get('/overview',            analyticsController.getAnalyticsOverview);

router.get('/activity-feed',       analyticsController.getActivityFeed);

router.get('/users/:userId/stats', analyticsController.getUserStats);

router.get('/export',              analyticsController.exportAnalytics);

router.post('/evaluate-badges',    analyticsController.triggerBadgeEvaluation);

export default router;