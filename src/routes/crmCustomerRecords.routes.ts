import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
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
router.get('/:id/timeline', getCustomerTimelineHandler);
router.get('/:id/feedback', getCustomerFeedbackHandler);
router.get('/:id/support-requests', listSupportRequestsHandler);
router.post('/:id/support-requests', createSupportRequestHandler);
router.patch('/:id/support-requests/:requestId', updateSupportRequestHandler);
router.get('/:id', getCustomerProfileHandler);
router.patch('/:id', updateCustomerRecordHandler);

export default router;
