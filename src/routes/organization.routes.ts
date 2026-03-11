import express from 'express';
import auth from '../middleware/auth.middleware';
import authorize from '../middleware/role.middleware';
import { requireAdmin } from '../middleware/rbac.middleware';
import {
    createOrganization,
    deleteOrganization,
    getMembers,
    getOrganization,
    removeMember,
    updateOrganization,
} from '../controllers/organization.controller';

const router = express.Router();

// All routes require authentication
router.use(auth());

// Global admin/super_admin or org-admin can manage orgs
router.post('/', authorize(['admin', 'super_admin']), createOrganization);
router.get('/:id', getOrganization);
router.patch('/:id', requireAdmin, updateOrganization);
router.delete('/:id', authorize(['super_admin']), deleteOrganization);

// Member management (Requires admin role within the organization)
router.get('/:id/members', requireAdmin, getMembers);
router.delete('/:id/members/:userId', requireAdmin, removeMember);

export default router;
