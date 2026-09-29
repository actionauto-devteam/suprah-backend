import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import { listPriceDropLogs, getPriceDropLog } from '../controllers/priceDropEmail.controller';

const router = Router();

router.use(crmAuth());

router.get('/', listPriceDropLogs);
router.get('/:id', getPriceDropLog);

export default router;
