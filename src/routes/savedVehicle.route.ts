import { Router } from 'express';
import auth from '../middleware/auth.middleware';
import {
    getSavedVehicles,
    saveVehicle,
    removeSavedVehicle,
} from '../controllers/savedVehicle.controller';

const router = Router();

router.use(auth());

router.get('/', getSavedVehicles);
router.post('/:vehicleId', saveVehicle);
router.delete('/:vehicleId', removeSavedVehicle);

export default router;
