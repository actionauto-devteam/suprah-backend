import { Router } from 'express';
import analyticsController from '../controllers/analytics.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = Router();

// All analytics routes require CRM authentication
router.use(crmAuth());

// ── Leaderboard (all authenticated users) ──────────────────────────────────
router.get('/leaderboard',         analyticsController.getLeaderboard);

// ── Personal stats (own data) ──────────────────────────────────────────────
router.get('/my-stats',            analyticsController.getMyStats);

// ── Org-level analytics (admin + manager) ─────────────────────────────────
router.get('/overview',            analyticsController.getAnalyticsOverview);

// ── Activity feed / tracking board ────────────────────────────────────────
router.get('/activity-feed',       analyticsController.getActivityFeed);

// ── User drill-down (admin + manager) ─────────────────────────────────────
router.get('/users/:userId/stats', analyticsController.getUserStats);

// ── Export (admin only) ───────────────────────────────────────────────────
router.get('/export',              analyticsController.exportAnalytics);

// ── Badge evaluation (admin) ──────────────────────────────────────────────
router.post('/evaluate-badges',    analyticsController.triggerBadgeEvaluation);

export default router;