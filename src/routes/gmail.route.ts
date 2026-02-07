import express from 'express';
import gmailController from '../controllers/gmail.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// All routes require authentication
router.use(auth());
router.use(requireOrg);

// Connection status
router.get('/status', gmailController.getConnectionStatus);

// Send email
router.post('/send', gmailController.sendEmail);

// Fetch emails
router.get('/fetch', gmailController.fetchEmails);

// Sync conversations
router.post('/sync', gmailController.syncConversations);

// Create external conversation
router.post('/conversations/external', gmailController.createExternalConversation);

// Link conversation to customer booking
router.post('/conversations/:conversationId/link-booking', gmailController.linkToCustomerBooking);

export default router;