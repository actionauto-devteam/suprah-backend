import express from 'express';
import customerCallController from '../controllers/customerCall.controller';
import mainAuth from '../middleware/auth.middleware';
import crmAuth from '../middleware/crmAuth.middleware';

const router = express.Router();

/**
 * Customer Call Center routes
 * ---------------------------
 * Split exactly like the customer-concern feature:
 *   • Customer-facing routes   → mainAuth()  (the main-app / Clerk-style token)
 *   • Staff (CRM) routes       → crmAuth()   (CRM employee or org-owner token)
 *
 * The one-way notification rule is structural: there is NO customer route for
 * posting messages. Customers can init, request a call, READ the status
 * timeline, and fetch a (gated) Jitsi token. Only staff routes can post.
 */

// ── Customer-facing (main app auth) ──────────────────────────────────────────
router.get('/init', mainAuth(), customerCallController.init);
router.post('/request', mainAuth(), customerCallController.requestCall);
router.get('/messages', mainAuth(), customerCallController.getCustomerMessages);
router.get('/video-token', mainAuth(), customerCallController.getCustomerVideoToken);

// ── Staff / CRM ──────────────────────────────────────────────────────────────
router.get('/crm/conversations', crmAuth(), customerCallController.crmGetConversations);
router.get('/crm/conversations/:id/messages', crmAuth(), customerCallController.crmGetMessages);
router.post('/crm/conversations/:id/status', crmAuth(), customerCallController.crmSendStatus);
router.post('/crm/conversations/:id/start', crmAuth(), customerCallController.crmStartCall);
router.post('/crm/conversations/:id/end', crmAuth(), customerCallController.crmEndCall);
router.get('/crm/conversations/:id/video-token', crmAuth(), customerCallController.crmGetVideoToken);

export default router;