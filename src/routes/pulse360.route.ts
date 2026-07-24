import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import pulse360Controller from '../controllers/pulse360.controller';

/**
 * Suprah Pulse360 — routes.
 *
 * Mounted at /api/crm/pulse360 and registered BEFORE the generic /crm route in
 * routes/index.ts, so crm.route.ts's `/users/:id` never swallows these paths.
 *
 * Static segments are declared before their `:id` siblings throughout —
 * /alerts/acknowledge-all has to win over /alerts/:id.
 */

const router = express.Router();

router.use(crmAuth());

// ── Me ──────────────────────────────────────────────────────────────────────
router.get('/me', pulse360Controller.getMe);
router.get('/me/timeline', pulse360Controller.getMyTimeline);
router.get('/me/next-actions', pulse360Controller.getMyNextActions);
router.post('/me/refresh', pulse360Controller.refreshMe);

// ── Alerts (static before param) ────────────────────────────────────────────
router.get('/alerts', pulse360Controller.listAlerts);
router.post('/alerts/acknowledge-all', pulse360Controller.acknowledgeAll);
router.post('/alerts/:id/acknowledge', pulse360Controller.acknowledgeAlert);
router.post('/alerts/:id/snooze', pulse360Controller.snoozeAlert);
router.post('/alerts/:id/resolve', pulse360Controller.resolveAlert);

// ── Management ──────────────────────────────────────────────────────────────
router.get('/overview', pulse360Controller.getOverview);
router.get('/settings', pulse360Controller.getSettings);
router.patch('/settings', pulse360Controller.updateSettings);
router.post('/evaluate', pulse360Controller.runEvaluation);

router.get('/users/:id/health', pulse360Controller.getUserHealth);
router.get('/users/:id/timeline', pulse360Controller.getUserTimeline);
router.post('/users/:id/nudge', pulse360Controller.nudgeUser);

// ── Ingest ──────────────────────────────────────────────────────────────────
router.post('/signals', pulse360Controller.createSignal);

export default router;
