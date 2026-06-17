import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  getPublicReferralInfo,
  submitReferralRequest,
  getReferralLeads,
  updateLeadStatus,
  convertLead,
  startLeadCall,
  getGuestCallToken,
} from '../controllers/referralLead.controller';

const router = express.Router();

// ─── Public (no auth) ─────────────────────────────────────────────────────────
router.get('/info/:code',             getPublicReferralInfo);
router.post('/request',               submitReferralRequest);
router.get('/call/:room/guest-token', getGuestCallToken);

// ─── CRM protected ────────────────────────────────────────────────────────────
router.get('/crm-leads',              crmAuth(), getReferralLeads);
router.patch('/crm-leads/:id/status', crmAuth(), updateLeadStatus);
router.post('/crm-leads/:id/convert', crmAuth(), convertLead);
router.post('/crm-leads/:id/start-call', crmAuth(), startLeadCall);

export default router;
