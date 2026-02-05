import express from 'express';
import conversationController from '../controllers/conversation.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

router.use(auth());
router.use(requireOrg);

router
    .route('/')
    .post(conversationController.createConversation)
    .get(conversationController.getConversations);

router
    .route('/:id')
    .delete(conversationController.deleteConversation);

router
    .route('/:id/messages')
    .post(conversationController.sendMessage);

router
    .route('/:id/read')
    .post(conversationController.markAsRead);

export default router;