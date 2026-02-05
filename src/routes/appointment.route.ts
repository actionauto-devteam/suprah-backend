import express from 'express';
import appointmentController from '../controllers/appointment.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// Public route for guest responses
router.post('/:id/guest-response', appointmentController.handleGuestResponse);

// Protected routes
router.use(auth());
router.use(requireOrg);

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