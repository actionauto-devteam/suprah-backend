import { Router } from 'express';
import conversationController from '../controllers/conversation.controller';
import authenticate from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = Router();

// All routes require authentication and organization context
router.use(authenticate);
router.use(requireOrg);

// Create new conversation
router.post(
  '/',
  conversationController.createConversation
);

// Get all user conversations
router.get(
  '/',
  conversationController.getUserConversations
);

// Sync Gmail inbox
router.post(
  '/sync-gmail',
  conversationController.syncGmailInbox
);

// Get specific conversation
router.get(
  '/:conversationId',
  conversationController.getConversationById
);

// Send message in conversation
router.post(
  '/:conversationId/messages',
  conversationController.sendMessage
);

// Add external email to conversation
router.post(
  '/:conversationId/external-email',
  conversationController.addExternalEmail
);

// Mark conversation as read
router.patch(
  '/:conversationId/read',
  conversationController.markAsRead
);

// Archive conversation
router.patch(
  '/:conversationId/archive',
  conversationController.archiveConversation
);

// Get conversations for customer booking
router.get(
  '/booking/:appointmentId/conversations',
  conversationController.getConversationsForBooking
);

export default router;