import express from 'express';
import appointmentController from '../controllers/appointment.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// Public route for guest responses (no auth required)
router.post('/:id/guest-response', appointmentController.handleGuestResponse);

// Protected routes
router.use(auth());
router.use(requireOrg);

// ============================================================
// IMPORTANT: Static routes MUST come BEFORE dynamic :id routes
// Otherwise Express matches "customer-bookings" as an :id param
// ============================================================

// Customer booking routes (static paths)
router.get('/customer-bookings/list', appointmentController.getCustomerBookings);
router.get('/customer-bookings/history', appointmentController.getCustomerHistory);
router.get('/customer-bookings/date-stats', appointmentController.getDateStatistics);

// Google Calendar sync (static path)
router.post('/sync/google-calendar', appointmentController.syncWithGoogleCalendar);

// Statistics (static path)
router.get('/stats/overview', appointmentController.getAppointmentStats);

// Base CRUD routes
router
  .route('/')
  .post(appointmentController.createAppointment)
  .get(appointmentController.getAppointments);

// Dynamic :id routes (MUST come after all static routes)
router
  .route('/:id')
  .get(appointmentController.getAppointmentById)
  .patch(appointmentController.updateAppointment)
  .delete(appointmentController.deleteAppointment);

router
  .route('/:id/cancel')
  .post(appointmentController.cancelAppointment);

export default router;