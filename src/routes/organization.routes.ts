import express from 'express';
import auth from '../middleware/auth.middleware';
import authorize from '../middleware/role.middleware';
import { requireAdmin } from '../middleware/rbac.middleware';
import {
    listPublicOrganizations,
    createOrganization,
    deleteOrganization,
    getMembers,
    getOrganization,
    removeMember,
    updateOrganization,
} from '../controllers/organization.controller';

const router = express.Router();

// PUBLIC — no auth. Must stay above `router.use(auth())` and above '/:id'
// so prospective customers can list dealerships during signup.
router.get('/public', listPublicOrganizations);

// All routes below require authentication
router.use(auth());

// Global admin/super_admin or org-admin can manage orgs
router.post('/', authorize(['admin', 'super_admin']), createOrganization);
router.get('/:id', getOrganization);
router.patch('/:id', requireAdmin, updateOrganization);
router.delete('/:id', authorize(['super_admin']), deleteOrganization);

// Member management (listing allowed for all members, removal for admin)
router.get('/:id/members', getMembers);
router.delete('/:id/members/:userId', requireAdmin, removeMember);

export default router;