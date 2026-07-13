import express from 'express';
import auth from '../middleware/auth.middleware';
import {
    acceptInvitation,
    createInvitation,
    validateInvitation,
    bulkCreateInvitations,
} from '../controllers/invitation.controller';

const router = express.Router();

router.get('/validate/:token', validateInvitation);

router.post('/accept', auth(), acceptInvitation);

router.post('/', auth(), createInvitation);

router.post('/bulk', auth(), bulkCreateInvitations);

export default router;
