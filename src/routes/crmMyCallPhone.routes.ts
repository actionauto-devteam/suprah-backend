import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import { getMyCallPhoneHandler, saveMyCallPhoneHandler, verifyMyCallPhoneHandler } from '../controllers/staffCallPhone.controller';

const router = express.Router();

router.use(crmAuth());
router.get('/', getMyCallPhoneHandler);
router.put('/', saveMyCallPhoneHandler);
router.post('/verify', verifyMyCallPhoneHandler);

export default router;
