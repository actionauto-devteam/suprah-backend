import express from 'express';
import googleCalendarController from '../controllers/googleCalendar.controller';
import auth from '../middleware/auth.middleware';
import { validateGoogleWebhook } from '../middleware/webhookValidation.middleware';

const router = express.Router();

router.get('/status', auth(), googleCalendarController.getStatus);
router.post('/disconnect', auth(), googleCalendarController.disconnect);

router.post('/sync-events', auth(), googleCalendarController.syncEvents);
router.post('/sync-rsvp/:appointmentId', auth(), googleCalendarController.syncRSVPStatus);

router.post(
  '/webhook',
  validateGoogleWebhook,
  googleCalendarController.handleWebhook
);

export default router;