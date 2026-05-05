import express from 'express';
import crmCalendarController from '../controllers/crmCalendar.controller';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

// Public callback (Google redirects here)
router.get('/callback', crmCalendarController.callback);

// Protected routes (Requires CRM Auth)
router.use(crmAuth());

router.get('/auth', crmCalendarController.connect);
router.get('/status', crmCalendarController.getStatus);
router.get('/appointments', crmCalendarController.getAppointments);
router.post('/appointments', crmCalendarController.createAppointment);
router.put('/appointments/:id', crmCalendarController.updateAppointment);
router.post('/appointments/:id/cancel', crmCalendarController.cancelAppointment);
router.post('/appointments/:id/status', crmCalendarController.updateStatus);
router.delete('/appointments/:id', crmCalendarController.deleteAppointment);
router.post('/sync', crmCalendarController.sync);
router.post('/disconnect', crmCalendarController.disconnect);


export default router;
