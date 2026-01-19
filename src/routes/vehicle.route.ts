import express from 'express';
import vehicleController from '../controllers/vehicle.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.use(auth());

router
    .route('/')
    .post(vehicleController.createVehicle)
    .get(vehicleController.getVehicles);

router
    .route('/:id')
    .get(vehicleController.getVehicleById)
    .put(vehicleController.updateVehicle);

export default router;
