import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  generateInviteLinks,
  bulkCreateCustomerAccounts,
} from '../controllers/customerInvite.controller';

const router = express.Router();

router.use(crmAuth());

router.post('/generate', generateInviteLinks);
router.post('/bulk-create', bulkCreateCustomerAccounts);

export default router;
