import express from 'express';
import vehicleController from '../controllers/vehicle.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';
import authorize from '../middleware/role.middleware';
import { marketplaceLimiter } from '../middleware/rate-limit.middleware';

const router = express.Router();

// Public showcase route (no auth required)
router.get('/public/:id', vehicleController.getPublicVehicleById);

// Apply authentication middleware to all other routes
router.use(auth());

// Middleware to protect non-GET routes with organization context
const requireOrgForMutation = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.method !== 'GET') {
        return requireOrg(req, res, next);
    }
    next();
};

router.use(requireOrgForMutation);

/**
 * SECURE MARKETPLACE ROUTES
 * Global access restricted to customers and authorized staff
 */
router.get('/marketplace', marketplaceLimiter, authorize(['customer', 'admin', 'super_admin']), vehicleController.getMarketplaceVehicles);
router.get('/marketplace/filters', authorize(['customer', 'admin', 'super_admin']), vehicleController.getMarketplaceFilters);

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