import express from 'express';
import { getOrganizationActivity } from '../controllers/activity.controller';
import auth from '../middleware/auth.middleware';
import { requireSuperAdmin } from '../middleware/rbac.middleware';

const router = express.Router();

// 1. All activity routes require authentication
router.use(auth());

/**
 * Get organization-wide activities
 * GET /api/activity/organization
 * Restricted to super_admin for cross-organization auditing or admins for their own org
 */
router.get(
    '/organization', 
    requireSuperAdmin, // For phase 1, restrict to super admins for the admin dashboard
    getOrganizationActivity
);

export default router;
