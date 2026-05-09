import express from 'express';
import customerController from '../controllers/customer.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// All customer routes require authentication + org context
router.use(auth());
router.use(requireOrg);

// ─── Stats (static, must come before :id) ────────────────────────────────────
router.get('/stats', customerController.getCustomerStats);

// ─── Duplicate check (before :id to avoid route conflict) ────────────────────
router.get('/check-duplicate', customerController.checkDuplicate);

// ─── Sync from lead ───────────────────────────────────────────────────────────
router.post('/sync-from-lead', customerController.syncFromLead);

// ─── Base CRUD ────────────────────────────────────────────────────────────────
router
  .route('/')
  .get(customerController.getCustomers)
  .post(customerController.createCustomer);

// ─── Dynamic :id routes ───────────────────────────────────────────────────────
router
  .route('/:id')
  .get(customerController.getCustomerById)
  .patch(customerController.updateCustomer)
  .delete(customerController.deleteCustomer);

// ─── Transactions ─────────────────────────────────────────────────────────────
router.post('/:id/transactions', customerController.addTransaction);
router.patch('/:id/transactions/:txId', customerController.updateTransaction);

// ─── Conversations ────────────────────────────────────────────────────────────
router.post('/:id/conversations', customerController.addConversation);

export default router;