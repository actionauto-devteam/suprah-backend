// Routes for ADF leads (Inquiries) - Main Entry Point
import { Router } from 'express';
import { receiveADF, getAllLeads, updateLead, createInquiry, markAsRead, markAsPending, replyToInquiry, syncGmailInquiries } from '../controllers/lead.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = Router();

// ADF endpoint (public, for incoming emails)
router.post('/adf', receiveADF);

// ============================================================
// Protected routes - ALL must have  auth BEFORE this line
// ============================================================
router.use(auth());
router.use(requireOrg);

// ============================================================
// Static routes MUST come BEFORE dynamic :id routes
// ============================================================

// Sync Gmail inquiries (static path)
router.post('/sync-gmail', syncGmailInquiries);

// Base CRUD routes
router
  .route('/')
  .post(createInquiry)
  .get(getAllLeads);

// ============================================================
// Dynamic :id routes (MUST come after all static routes)
// ============================================================

router.patch('/:id/read', markAsRead);
router.patch('/:id/pending', markAsPending);
router.post('/:id/reply', replyToInquiry);
router.patch('/:id', updateLead);

export default router;