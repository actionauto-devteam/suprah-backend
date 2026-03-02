import { Router } from 'express';
import auth from '../middleware/auth.middleware';
import {
    addOwnedVehicle,
    getOwnedVehicles,
    updateOwnedVehicleMileage,
    decodeVin,
    updateOwnedVehicle,
    deleteOwnedVehicle
} from '../controllers/ownedVehicle.controller';

const router = Router();

// All customer vehicle routes are protected
router.use(auth());

router.post('/', addOwnedVehicle);
router.get('/', getOwnedVehicles);
router.get('/decode/:vin', decodeVin);
router.patch('/:id/mileage', updateOwnedVehicleMileage);
router.put('/:id', updateOwnedVehicle);
router.delete('/:id', deleteOwnedVehicle);

export default router;
