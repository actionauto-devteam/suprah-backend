import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import { getCustomerCatchUpStatusHandler, getCustomerProfileHandler, getCustomerTimelineHandler, listCustomerRecordsHandler, updateCustomerRecordHandler } from '../controllers/customerRecords.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', listCustomerRecordsHandler);
router.get('/catch-up', getCustomerCatchUpStatusHandler);
router.get('/:id/timeline', getCustomerTimelineHandler);
router.get('/:id', getCustomerProfileHandler);
router.patch('/:id', updateCustomerRecordHandler);

export default router;
