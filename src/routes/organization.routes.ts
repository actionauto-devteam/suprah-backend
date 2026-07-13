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

router.get('/public', listPublicOrganizations);

router.use(auth());

router.post('/', authorize(['admin', 'super_admin']), createOrganization);
router.get('/:id', getOrganization);
router.patch('/:id', requireAdmin, updateOrganization);
router.delete('/:id', authorize(['super_admin']), deleteOrganization);

router.get('/:id/members', getMembers);
router.delete('/:id/members/:userId', requireAdmin, removeMember);

export default router;