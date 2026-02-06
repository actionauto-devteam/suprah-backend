import express from 'express';
import googleCalendarController from '../controllers/googleCalendar.controller';
import authenticate from '../middleware/auth.middleware';
import { validateGoogleWebhook } from '../middleware/webhookValidation.middleware';

const router = express.Router();

// OAuth flow
router.get('/auth', authenticate, googleCalendarController.initiateAuth);
router.get('/callback', googleCalendarController.handleCallback);

// Status and management
router.get('/status', authenticate, googleCalendarController.getStatus);
router.post('/disconnect', authenticate, googleCalendarController.disconnect);

// Manual sync endpoints
router.post('/sync-events', authenticate, googleCalendarController.syncEvents);
router.post('/sync-rsvp/:appointmentId', authenticate, googleCalendarController.syncRSVPStatus);

// Webhook endpoint - Public but validated
router.post(
  '/webhook',
  validateGoogleWebhook,
  googleCalendarController.handleWebhook
);

export default router;