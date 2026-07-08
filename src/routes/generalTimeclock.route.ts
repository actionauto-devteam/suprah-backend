import { NextFunction, Request, Response, Router } from 'express';
import auth from '../middleware/auth.middleware';
import crmAuth from '../middleware/crmAuth.middleware';
import { getMe, timeClock, getShiftState, getMyTimeproof, getResumableShift } from '../controllers/generalTimeclock.controller';

const router = Router();

// Dual-auth: try main User JWT first, fall back to CRM JWT
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
router.get('/resumable-shift', getResumableShift);

export default router;
