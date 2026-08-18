import express from 'express';
// v1.4.0
import crmAuth from '../middleware/crmAuth.middleware';
import { uploadScreenshot } from '../middleware/upload.middleware';
import {
  getMyTimeproof,
  getAllUsersTimeproof,
  getUserTimeproof,
  exportTimeproof,
  getShiftState,
  getResumableShift,
  resumeShift,
  postHeartbeat,
  postActivityInterval,
  getMyAgentStatus,
  getAgentStatus,
  submitScreenshot,
  submitScreenshotPlaceholder,
  getScreenshots,
  getBlurredScreenshot,
  deleteMyScreenshot,
  wipeAllScreenshotsHandler,
  subscribeCrmPush,
  unsubscribeCrmPush,
  getCrmPushStatus,
  getOrgPushHealth,
  correctTimeLog,
  getAdminDayLogs,
  adminTimeOverride,
  excludeScreenshots,
  getMyIdleLog,
  getUserIdleLog,
  clockOutUser,
  postClientDiagnostic,
  getUserIdleDiagnostics,
  updateHourlyRate,
  getHourlyRateHistory,
  markPeriodPaid,
  unlockPayPeriod,
  getPayrollStatus,
  getWeeklyOvertimeReport,
} from '../controllers/crmTimeproof.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/my', getMyTimeproof);
router.get('/users', getAllUsersTimeproof);
router.get('/user/:userId', getUserTimeproof);
router.get('/export', exportTimeproof);
router.get('/idle-log', getMyIdleLog);
router.get('/user/:userId/idle-log', getUserIdleLog);
router.get('/user/:userId/idle-diagnostics', getUserIdleDiagnostics);

router.get('/shift-state', getShiftState);
router.get('/resumable-shift', getResumableShift);
router.post('/resume-shift', resumeShift);
router.get('/my-agent', getMyAgentStatus);
router.post('/heartbeat', postHeartbeat);
router.post('/activity-interval', postActivityInterval);
router.post('/client-diagnostics', postClientDiagnostic);
router.get('/agent-status', getAgentStatus);
router.post('/screenshots', uploadScreenshot, submitScreenshot);
router.post('/screenshots/placeholder', submitScreenshotPlaceholder);
router.get('/screenshots', getScreenshots);
router.get('/screenshot-blurred', getBlurredScreenshot);
router.delete('/screenshots', deleteMyScreenshot); // self-service only, ownership check inside
router.post('/screenshots/wipe-all', wipeAllScreenshotsHandler); // admin-only, role check inside
router.post('/screenshots/exclude', excludeScreenshots); // admin/manager-only, role + department exemption check inside

router.patch('/correct-time', correctTimeLog);
router.get('/admin/day-logs', getAdminDayLogs);
router.post('/admin/time-override', adminTimeOverride);
router.post('/users/:userId/clock-out', clockOutUser); // admin/manager-only, role check inside

router.patch('/user/:userId/hourly-rate', updateHourlyRate); // admin/manager-only, role check inside
router.get('/user/:userId/hourly-rate-history', getHourlyRateHistory); // admin/manager-only, role check inside
router.post('/user/:userId/mark-paid', markPeriodPaid); // admin/manager-only, role check inside
router.post('/user/:userId/unlock-period', unlockPayPeriod); // admin-only, role check inside
router.get('/payroll-status', getPayrollStatus); // admin/manager-only, role check inside
router.get('/weekly-overtime-report', getWeeklyOvertimeReport); // admin/manager-only, role check inside

router.post('/push/subscribe', subscribeCrmPush);
router.delete('/push/subscribe', unsubscribeCrmPush);
router.get('/push/status', getCrmPushStatus);
router.get('/push/org-health', getOrgPushHealth); // admin/manager-only, role check inside

export default router;
