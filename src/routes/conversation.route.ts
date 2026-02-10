import { Router } from 'express';
import conversationController from '../controllers/conversation.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = Router();

// =====================================================================
// CRITICAL FIX #1: auth() WITH PARENTHESES
//
// The original code had:
//   import authenticate from '../middleware/auth.middleware';
//   router.use(authenticate);
//
// This is WRONG because auth.middleware.ts exports a FACTORY FUNCTION.
// When Express calls authenticate(req, res, next), it treats `req` as
// the factory's config argument, returns a middleware function, and
// NEVER calls next(). Every request hangs forever → infinite loading.
//
// The fix: call auth() to GET the middleware, then pass THAT to Express.
// =====================================================================
router.use(auth());
router.use(requireOrg);

// =====================================================================
// CRITICAL FIX #2: Static routes BEFORE dynamic /:conversationId
//
// Without this fix, "sync-gmail" and "booking" are matched as a
// conversationId value, causing 404 errors.
// =====================================================================

// Create new conversation
router.post('/', conversationController.createConversation);

// Get all user conversations
router.get('/', conversationController.getUserConversations);

// Sync Gmail inbox — STATIC path, must be before /:conversationId
router.post('/sync-gmail', conversationController.syncGmailInbox);

// Get conversations for a specific customer booking — STATIC path
router.get(
  '/booking/:appointmentId/conversations',
  conversationController.getConversationsForBooking
);

// =====================================================================
// DYNAMIC routes — /:conversationId catches everything not matched above
// =====================================================================
router.get('/:conversationId', conversationController.getConversationById);
router.post('/:conversationId/messages', conversationController.sendMessage);
router.post('/:conversationId/external-email', conversationController.addExternalEmail);
router.patch('/:conversationId/read', conversationController.markAsRead);
router.patch('/:conversationId/archive', conversationController.archiveConversation);

export default router;