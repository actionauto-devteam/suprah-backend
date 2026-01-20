import express from 'express';
import vehicleController from '../controllers/vehicle.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// Apply authentication middleware to all routes
router.use(auth());

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

export default router;