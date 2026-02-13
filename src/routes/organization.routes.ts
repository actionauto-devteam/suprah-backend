import express from 'express';
import auth from '../middleware/auth.middleware';
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

router.post('/', createOrganization);
router.get('/:id', getOrganization);
router.patch('/:id', updateOrganization);
router.delete('/:id', deleteOrganization);

// Member management
router.get('/:id/members', getMembers);
router.delete('/:id/members/:userId', removeMember);

export default router;
