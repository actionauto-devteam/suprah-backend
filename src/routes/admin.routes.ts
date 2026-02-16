import express from 'express';
import adminController from '../controllers/admin.controller';
import auth from '../middleware/auth.middleware';
import { ApiError } from '../utils/ApiError';

const router = express.Router();

// Middleware to ensure user is Super Admin
const requireSuperAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.user?.role !== 'super_admin') {
        return next(new ApiError(403, 'Requires Super Admin privileges'));
    }
    next();
};

// All routes require authentication and super_admin role
router.use(auth());
router.use(requireSuperAdmin);

router.get('/organizations', adminController.getAllOrganizations);
router.get('/users', adminController.getAllUsers);
router.get('/stats', adminController.getSystemStats);

export default router;
