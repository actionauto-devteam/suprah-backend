import express from 'express';
import appointmentController from '../controllers/appointment.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

router.post('/:id/guest-response', appointmentController.handleGuestResponse);

router.use(auth());
router.use(requireOrg);


router.get('/customer-bookings/list', appointmentController.getCustomerBookings);
router.get('/customer-bookings/history', appointmentController.getCustomerHistory);
router.get('/customer-bookings/date-stats', appointmentController.getDateStatistics);

router.post('/sync/google-calendar', appointmentController.syncWithGoogleCalendar);

router.get('/stats/overview', appointmentController.getAppointmentStats);

router
  .route('/')
  .post(appointmentController.createAppointment)
  .get(appointmentController.getAppointments);

router
  .route('/:id')
  .get(appointmentController.getAppointmentById)
  .patch(appointmentController.updateAppointment)
  .delete(appointmentController.deleteAppointment);

router
  .route('/:id/cancel')
  .post(appointmentController.cancelAppointment);

export default router;