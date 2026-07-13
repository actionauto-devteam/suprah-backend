import express from 'express';
import customerController from '../controllers/customer.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

router.use(auth());
router.use(requireOrg);

router.get('/stats', customerController.getCustomerStats);
router.get('/check-duplicate', customerController.checkDuplicate);

router
  .route('/')
  .get(customerController.getCustomers)
  .post(customerController.createCustomer);

router.post('/sync-from-lead', customerController.syncFromLead);
router.post('/sync-from-leads', customerController.syncFromLeads);
router.post('/backfill-from-leads', customerController.backfillFromLeads);

router
  .route('/:id')
  .get(customerController.getCustomerById)
  .patch(customerController.updateCustomer)
  .delete(customerController.deleteCustomer);

router.post('/:id/transactions', customerController.addTransaction);
router.patch('/:id/transactions/:txId', customerController.updateTransaction);

router.post('/:id/conversations', customerController.addConversation);

export default router;