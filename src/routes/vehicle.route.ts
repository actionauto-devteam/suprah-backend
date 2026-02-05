import express from 'express';
import vehicleController from '../controllers/vehicle.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(auth());
router.use(requireOrg);

// Filter and statistics routes (must be before /:id routes)
router.get('/filters', vehicleController.getFilters);
router.get('/stats', vehicleController.getStats);
router.get('/dashboard/graphs', vehicleController.getDashboardGraphs);

// Phase 2: Status management and export
router.get('/dashboard', vehicleController.getDashboard);
router.get('/export', vehicleController.exportVehicles);

// Phase 3: Autocomplete and availability
router.get('/search/autocomplete', vehicleController.autocomplete);

// Vehicle CRUD routes
router
    .route('/')
    .post(vehicleController.createVehicle)
    .get(vehicleController.getVehicles);

router
    .route('/:id')
    .get(vehicleController.getVehicleById)
    .put(vehicleController.updateVehicle)
    .delete(vehicleController.deleteVehicle);

router
    .route('/:id/notes')
    .post(vehicleController.addVehicleNote);

router.patch('/:id/status', vehicleController.updateVehicleStatus);

router.get('/:id/availability', vehicleController.checkAvailability);
router.post('/:id/reserve', vehicleController.reserveVehicle);

export default router;