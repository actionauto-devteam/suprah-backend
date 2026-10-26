import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import { getCustomerProfileHandler, listCustomerRecordsHandler, updateCustomerRecordHandler } from '../controllers/customerRecords.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', listCustomerRecordsHandler);
router.get('/:id', getCustomerProfileHandler);
router.patch('/:id', updateCustomerRecordHandler);

export default router;
