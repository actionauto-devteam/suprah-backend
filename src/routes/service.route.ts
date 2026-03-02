import express from 'express';
import { getJiffyLubeLocations, getMaintenanceReminders, logServiceEvent, getVehicleServiceHistory } from '../controllers/service.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// All service routes are protected
router.use(auth());

router.get('/locations', getJiffyLubeLocations);
router.get('/reminders', getMaintenanceReminders);
router.post('/log', logServiceEvent);
router.get('/history/:vehicleId', getVehicleServiceHistory);

export default router;
