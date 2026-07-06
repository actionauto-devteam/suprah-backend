import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  generateInviteLinks,
  bulkCreateCustomerAccounts,
  getCustomers,
  deleteCustomer,
} from '../controllers/customerInvite.controller';

const router = express.Router();

router.use(crmAuth());

router.post('/generate', generateInviteLinks);
router.post('/bulk-create', bulkCreateCustomerAccounts);
router.get('/customers', getCustomers);
router.delete('/customers/:userId', deleteCustomer);

export default router;
