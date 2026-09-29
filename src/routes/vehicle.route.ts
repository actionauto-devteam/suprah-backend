import express from 'express';
import vehicleController from '../controllers/vehicle.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';
import { marketplaceLimiter } from '../middleware/rate-limit.middleware';
import authorize from '../middleware/role.middleware';

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

// Dealer inventory (cost, notes, exports and every change) is for the
// organization's staff. Customers use the marketplace, public and
// single-vehicle views below, which return the customer-safe fields only.
const staffOnly = authorize(
    ['super_admin', 'admin', 'employee'],
    "Only your organization's staff can view or change inventory details.",
);

router.get('/marketplace', marketplaceLimiter, vehicleController.getMarketplaceVehicles);
router.get('/marketplace/filters', vehicleController.getMarketplaceFilters);

router.get('/filters', staffOnly, vehicleController.getFilters);
router.get('/stats', staffOnly, vehicleController.getStats);
router.get('/dashboard/graphs', staffOnly, vehicleController.getDashboardGraphs);

router.get('/dashboard', staffOnly, vehicleController.getDashboard);
router.get('/export', staffOnly, vehicleController.exportVehicles);

router.get('/search/autocomplete', staffOnly, vehicleController.autocomplete);

router
    .route('/')
    .post(staffOnly, vehicleController.createVehicle)
    .get(staffOnly, vehicleController.getVehicles);

router.get('/:id/price-history', staffOnly, vehicleController.getVehiclePriceHistory);

router
    .route('/:id')
    .get(vehicleController.getVehicleById)
    .put(staffOnly, vehicleController.updateVehicle)
    .delete(staffOnly, vehicleController.deleteVehicle);

router
    .route('/:id/notes')
    .post(staffOnly, vehicleController.addVehicleNote);

router.patch('/:id/status', staffOnly, vehicleController.updateVehicleStatus);

router.get('/:id/availability', staffOnly, vehicleController.checkAvailability);
router.post('/:id/reserve', staffOnly, vehicleController.reserveVehicle);

export default router;