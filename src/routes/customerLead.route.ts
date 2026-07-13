import { Router } from 'express';
import customerLeadController from '../controllers/customerLead.controller';
import auth from '../middleware/auth.middleware';
import { resolveLeadContext } from '../middleware/leadContext.middleware';

const router = Router();

router.use(auth());

router.post('/inquiry', resolveLeadContext, customerLeadController.submitInquiry);

router.post('/finance', resolveLeadContext, customerLeadController.submitFinanceApp);

export default router;
