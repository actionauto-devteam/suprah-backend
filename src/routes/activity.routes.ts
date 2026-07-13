import express from 'express';
import { getOrganizationActivity } from '../controllers/activity.controller';
import auth from '../middleware/auth.middleware';
import { requireSuperAdmin } from '../middleware/rbac.middleware';

const router = express.Router();

router.use(auth());

router.get(
    '/organization', 
    requireSuperAdmin,
    getOrganizationActivity
);

export default router;
