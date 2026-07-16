import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import { uploadScreenshot } from '../middleware/upload.middleware';
import {
  getMyTimeproof,
  getAllUsersTimeproof,
  getUserTimeproof,
  exportTimeproof,
  getShiftState,
  getResumableShift,
  postHeartbeat,
  postActivityInterval,
  getMyAgentStatus,
  getAgentStatus,
  submitScreenshot,
  getScreenshots,
  getBlurredScreenshot,
  deleteMyScreenshot,
  wipeAllScreenshotsHandler,
  subscribeCrmPush,
  unsubscribeCrmPush,
  correctTimeLog,
  excludeScreenshots,
  getMyIdleLog,
  getUserIdleLog,
  clockOutUser,
} from '../controllers/crmTimeproof.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/my', getMyTimeproof);
router.get('/users', getAllUsersTimeproof);
router.get('/user/:userId', getUserTimeproof);
router.get('/export', exportTimeproof);
router.get('/idle-log', getMyIdleLog);
router.get('/user/:userId/idle-log', getUserIdleLog);

router.get('/shift-state', getShiftState);
router.get('/resumable-shift', getResumableShift);
router.get('/my-agent', getMyAgentStatus);
router.post('/heartbeat', postHeartbeat);
router.post('/activity-interval', postActivityInterval);
router.get('/agent-status', getAgentStatus);
router.post('/screenshots', uploadScreenshot, submitScreenshot);
router.get('/screenshots', getScreenshots);
router.get('/screenshot-blurred', getBlurredScreenshot);
router.delete('/screenshots', deleteMyScreenshot); // self-service only, ownership check inside
router.post('/screenshots/wipe-all', wipeAllScreenshotsHandler); // admin-only, role check inside
router.post('/screenshots/exclude', excludeScreenshots); // admin/manager-only, role + department exemption check inside

router.patch('/correct-time', correctTimeLog);
router.post('/users/:userId/clock-out', clockOutUser); // admin/manager-only, role check inside

router.post('/push/subscribe', subscribeCrmPush);
router.delete('/push/subscribe', unsubscribeCrmPush);

export default router;
