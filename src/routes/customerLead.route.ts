import { Router } from 'express';
import customerLeadController from '../controllers/customerLead.controller';
import auth from '../middleware/auth.middleware';
import { resolveLeadContext } from '../middleware/leadContext.middleware';

const router = Router();

// All routes here require authentication (Customer role)
router.use(auth());

/**
 * @route   POST /api/leads/customer/inquiry
 * @desc    Submit a vehicle inquiry (Check Availability)
 * @access  Private (Customer)
 */
router.post('/inquiry', resolveLeadContext, customerLeadController.submitInquiry);

/**
 * @route   POST /api/leads/customer/finance
 * @desc    Submit a finance application
 * @access  Private (Customer)
 */
router.post('/finance', resolveLeadContext, customerLeadController.submitFinanceApp);

export default router;
