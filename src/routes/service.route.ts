import express from 'express';
import { getJiffyLubeLocations, getMaintenanceReminders, logServiceEvent, getVehicleServiceHistory, getActiveServiceStatus, updateServiceStatus } from '../controllers/service.controller';
import { getAvailableSlots, getMonthAvailability } from '../controllers/serviceSlot.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// All service routes are protected
router.use(auth());

router.get('/locations', getJiffyLubeLocations);
router.get('/reminders', getMaintenanceReminders);
router.post('/log', logServiceEvent);
router.get('/history/:vehicleId', getVehicleServiceHistory);
router.get('/active/:vehicleId', getActiveServiceStatus);
router.patch('/status/:serviceId', updateServiceStatus);

// Slot availability (customer-facing)
router.get('/slots/available', getAvailableSlots);
router.get('/slots/calendar', getMonthAvailability);

export default router;
