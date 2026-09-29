import { Router } from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  listReengagementLogs,
  getReengagementLog,
  sendAnyway,
} from '../controllers/vehicleReengagement.controller';

const router = Router();

router.use(crmAuth());

router.get('/', listReengagementLogs);
router.get('/:id', getReengagementLog);
router.post('/:id/send-anyway', sendAnyway);

export default router;
