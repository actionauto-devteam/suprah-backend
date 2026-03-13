import express from 'express';
import auth from '../middleware/auth.middleware';
import {
    acceptInvitation,
    createInvitation,
    validateInvitation,
    bulkCreateInvitations,
} from '../controllers/invitation.controller';

const router = express.Router();

// Validate token does NOT require auth (it's public info to show the "Accept" page)
router.get('/validate/:token', validateInvitation);

// Accept requires auth (must be logged in to join)
router.post('/accept', auth(), acceptInvitation);

// Create requires auth (admin only)
router.post('/', auth(), createInvitation);

// Bulk create requires auth (admin only)
router.post('/bulk', auth(), bulkCreateInvitations);

export default router;
