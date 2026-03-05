// Routes for Leads — Centralized Ingestion
import { Router } from 'express';
import {
  receiveADF,
  getAllLeads,
  updateLead,
  createInquiry,
  markAsRead,
  markAsPending,
  replyToInquiry,
  syncCentralGmail,
  syncGmailInquiries,
  setAppointmentForLead,
  getThreadMessages,
  getCentralSyncStatus,
} from '../controllers/lead.controller';
import auth from '../middleware/auth.middleware';

const router = Router();

// ── ADF endpoint (public, for incoming email webhooks) ───────────────────────
router.post('/adf', receiveADF);

// ── All lead routes require authentication ───────────────────────────────────
// NOTE: requireOrg is intentionally NOT used here.
// Leads are already scoped to the individual user via createdBy: userId.
// requireOrg would block users without an organizationId from accessing
// their own leads, which is incorrect behaviour.
router.use(auth());

// ── Static routes BEFORE dynamic :id routes ──────────────────────────────────

// Centralized sync — actionautoutah.dev@gmail.com
router.post('/sync-central', syncCentralGmail);

// Legacy endpoint — redirects to centralized sync
router.post('/sync-gmail', syncGmailInquiries);

// Centralized ingestion status
router.get('/sync-status', getCentralSyncStatus);

// Base CRUD
router.route('/')
  .get(getAllLeads)
  .post(createInquiry);

// ── Dynamic :id routes ────────────────────────────────────────────────────────
router.get('/:id/thread', getThreadMessages);
router.patch('/:id/read', markAsRead);
router.patch('/:id/pending', markAsPending);
router.post('/:id/appointment', setAppointmentForLead);
router.post('/:id/reply', replyToInquiry);
router.patch('/:id', updateLead);

export default router;