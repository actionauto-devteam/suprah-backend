import { Router } from 'express';
import auth from '../middleware/auth.middleware';
import scheduleController from '../controllers/schedule.controller';

const router = Router();
router.use(auth());

router.get('/',         scheduleController.getShifts);
router.post('/',        scheduleController.createShift);
router.patch('/:id',    scheduleController.updateShift);
router.delete('/:id',   scheduleController.deleteShift);

export default router;
