// Routes for ADF leads (Inquiries) - Main Entry Point
import { Router } from 'express';
import { receiveADF, getAllLeads, updateLead, createInquiry, markAsRead, markAsPending, replyToInquiry, syncGmailInquiries } from '../controllers/lead.controller';

const router = Router();

// POST /api/leads - Create new inquiry (manual/test entry)
router.post('/', createInquiry);

// POST /api/leads/adf - For incoming ADF emails
router.post('/adf', receiveADF);

// POST /api/leads/sync-gmail - Sync inquiries from Gmail
router.post('/sync-gmail', syncGmailInquiries);

// GET /api/leads - For the frontend list
router.get('/', getAllLeads);

// PATCH /api/leads/:id - Update lead status
router.patch('/:id', updateLead);

// PATCH /api/leads/:id/read - Mark as read
router.patch('/:id/read', markAsRead);

// PATCH /api/leads/:id/pending - Mark as pending
router.patch('/:id/pending', markAsPending);

// POST /api/leads/:id/reply - Reply to inquiry
router.post('/:id/reply', replyToInquiry);

export default router;