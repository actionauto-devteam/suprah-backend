import { NextFunction, Request, Response, Router } from 'express';
import auth from '../middleware/auth.middleware';
import crmAuth from '../middleware/crmAuth.middleware';
import locatorController from '../controllers/locator.controller';

const router = Router();

router.use((req: Request, res: Response, next: NextFunction) => {
  auth()(req, res, (authError) => {
    if (!authError) return next();
    crmAuth()(req, res, next);
  });
});

router.get('/my-status', locatorController.getMyLocatorStatus);
router.post('/consent', locatorController.setLocationConsent);
router.post('/sharing-preference', locatorController.setLocationSharingOptOut);

router.post('/ping', locatorController.ingestLocation);
router.post('/pause', locatorController.pauseSharing);
router.post('/resume', locatorController.resumeSharing);
router.post('/off-duty', locatorController.stopSharing);
router.get('/active', locatorController.getActiveEmployeeLocations);

router.get('/places', locatorController.getPlaces);
router.post('/places', locatorController.createPlace);
router.patch('/places/:id', locatorController.updatePlace);
router.delete('/places/:id', locatorController.deletePlace);
router.post('/places/:id/check-in', locatorController.manualCheckIn);

router.get('/history/:userId', locatorController.getLocationHistory);
router.get('/reports/time-at-place', locatorController.getTimeAtPlaceReport);
router.get('/daily-activity', locatorController.getDailyActivityLog);

router.get('/driving-sessions', locatorController.getDrivingSessions);
router.get('/driving-sessions/:id', locatorController.getDrivingSessionDetail);
router.post('/driving-sessions/:id/incident-response', locatorController.respondToIncident);

router.post('/sos', locatorController.triggerSos);
router.post('/sos/:id/resolve', locatorController.resolveSos);
router.get('/sos/active', locatorController.getActiveSosAlerts);

export default router;
