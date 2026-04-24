import express from 'express';
import googleCalendarController from '../controllers/googleCalendar.controller';
import auth from '../middleware/auth.middleware';
import { validateGoogleWebhook } from '../middleware/webhookValidation.middleware';

const router = express.Router();

// Status and management (auth required)
router.get('/status', auth(), googleCalendarController.getStatus);
router.post('/disconnect', auth(), googleCalendarController.disconnect);

// Manual sync endpoints (auth required)
router.post('/sync-events', auth(), googleCalendarController.syncEvents);
router.post('/sync-rsvp/:appointmentId', auth(), googleCalendarController.syncRSVPStatus);

// Webhook endpoint - Public but validated
router.post(
  '/webhook',
  validateGoogleWebhook,
  googleCalendarController.handleWebhook
);

export default router;