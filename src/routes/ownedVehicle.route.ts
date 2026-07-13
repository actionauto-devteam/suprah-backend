import { Router } from 'express';
import auth from '../middleware/auth.middleware';
import { uploadVehicleImage } from '../middleware/upload.middleware';
import {
    addOwnedVehicle,
    getOwnedVehicles,
    updateOwnedVehicleMileage,
    decodeVin,
    updateOwnedVehicle,
    uploadOwnedVehicleImage,
    deleteOwnedVehicle
} from '../controllers/ownedVehicle.controller';

const router = Router();

router.use(auth());

router.post('/', addOwnedVehicle);
router.get('/', getOwnedVehicles);
router.get('/decode/:vin', decodeVin);
router.patch('/:id/mileage', updateOwnedVehicleMileage);
router.put('/:id', updateOwnedVehicle);
router.post('/:id/image', uploadVehicleImage, uploadOwnedVehicleImage);
router.delete('/:id', deleteOwnedVehicle);

export default router;
