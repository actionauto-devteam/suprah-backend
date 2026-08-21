import express from 'express';
import vehicleController from '../controllers/vehicle.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';
import { marketplaceLimiter } from '../middleware/rate-limit.middleware';

const router = express.Router();

router.get('/public/:id', vehicleController.getPublicVehicleById);

router.use(auth());

const requireOrgForMutation = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method !== 'GET') {
        return requireOrg(req, res, next);
    }
    next();
};

router.use(requireOrgForMutation);

router.get('/marketplace', marketplaceLimiter, vehicleController.getMarketplaceVehicles);
router.get('/marketplace/filters', vehicleController.getMarketplaceFilters);

router.get('/filters', vehicleController.getFilters);
router.get('/stats', vehicleController.getStats);
router.get('/dashboard/graphs', vehicleController.getDashboardGraphs);

router.get('/dashboard', vehicleController.getDashboard);
router.get('/export', vehicleController.exportVehicles);

router.get('/search/autocomplete', vehicleController.autocomplete);

router
    .route('/')
    .post(vehicleController.createVehicle)
    .get(vehicleController.getVehicles);

router.get('/:id/price-history', vehicleController.getVehiclePriceHistory);

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