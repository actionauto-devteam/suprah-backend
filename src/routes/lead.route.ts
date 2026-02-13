// Routes for ADF leads (Inquiries) - Main Entry Point
import { Router } from 'express';
import { receiveADF, getAllLeads, updateLead, createInquiry } from '../controllers/lead.controller';

const router = Router();

// POST /api/leads - Create new inquiry (manual/test entry)
router.post('/', createInquiry);

// POST /api/leads/adf - For incoming ADF emails
router.post('/adf', receiveADF);

// GET /api/leads - For the frontend list
router.get('/', getAllLeads);

// PATCH /api/leads/:id - Update lead status
router.patch('/:id', updateLead);

export default router;