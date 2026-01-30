import express from 'express';
import appointmentController from '../controllers/appointment.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.use(auth());

router
    .route('/')
    .post(appointmentController.createAppointment)
    .get(appointmentController.getAppointments);

router
    .route('/:id')
    .patch(appointmentController.updateAppointment)
    .delete(appointmentController.deleteAppointment);

router
    .route('/:id/cancel')
    .post(appointmentController.cancelAppointment);

export default router;