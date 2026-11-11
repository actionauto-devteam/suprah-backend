import express from 'express';
import auth from '../middleware/auth.middleware';
import {
    acceptInvitation,
    createInvitation,
    validateInvitation,
    bulkCreateInvitations,
} from '../controllers/invitation.controller';
import { staffBulkInviteLimiter, staffInviteSendLimiter } from '../middleware/staffInviteRateLimit.middleware';

const router = express.Router();

router.get('/validate/:token', validateInvitation);

router.post('/accept', auth(), acceptInvitation);

router.post('/', auth(), staffInviteSendLimiter, createInvitation);

router.post('/bulk', auth(), staffBulkInviteLimiter, bulkCreateInvitations);

export default router;
