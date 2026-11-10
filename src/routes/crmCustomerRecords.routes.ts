import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  createPurchaseHandler,
  deletePurchaseHandler,
  importPurchasesHandler,
  listPurchasesHandler,
  updatePurchaseHandler,
  createSupportRequestHandler,
  getCustomerCatchUpStatusHandler,
  getCustomerFeedbackHandler,
  getCustomerProfileHandler,
  getCustomerTimelineHandler,
  listCustomerRecordsHandler,
  listSupportRequestsHandler,
  updateCustomerRecordHandler,
  updateSupportRequestHandler,
} from '../controllers/customerRecords.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', listCustomerRecordsHandler);
router.get('/catch-up', getCustomerCatchUpStatusHandler);
router.post('/purchases/import', importPurchasesHandler);
router.get('/:id/purchases', listPurchasesHandler);
router.post('/:id/purchases', createPurchaseHandler);
router.patch('/:id/purchases/:purchaseId', updatePurchaseHandler);
router.delete('/:id/purchases/:purchaseId', deletePurchaseHandler);
router.get('/:id/timeline', getCustomerTimelineHandler);
router.get('/:id/feedback', getCustomerFeedbackHandler);
router.get('/:id/support-requests', listSupportRequestsHandler);
router.post('/:id/support-requests', createSupportRequestHandler);
router.patch('/:id/support-requests/:requestId', updateSupportRequestHandler);
router.get('/:id', getCustomerProfileHandler);
router.patch('/:id', updateCustomerRecordHandler);

export default router;
