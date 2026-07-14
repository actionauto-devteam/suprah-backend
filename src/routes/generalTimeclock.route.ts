import { NextFunction, Request, Response, Router } from 'express';
import auth from '../middleware/auth.middleware';
import crmAuth from '../middleware/crmAuth.middleware';
import { getMe, timeClock, getShiftState, getMyTimeproof, getMyIdleLog, getResumableShift, postHeartbeat, postActivityInterval } from '../controllers/generalTimeclock.controller';

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  auth()(req, res, (authError) => {
    if (!authError) return next();
    crmAuth()(req, res, next);
  });
});

router.get('/me', getMe);
router.post('/clock', timeClock);
router.get('/shift-state', getShiftState);
router.get('/my', getMyTimeproof);
router.get('/idle-log', getMyIdleLog);
router.get('/resumable-shift', getResumableShift);
router.post('/heartbeat', postHeartbeat);
router.post('/activity-interval', postActivityInterval);

export default router;
