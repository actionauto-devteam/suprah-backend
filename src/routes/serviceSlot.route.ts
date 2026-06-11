import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  getCrmSlots,
  createSlot,
  updateSlot,
  deleteSlot,
  getDateBookings,
} from '../controllers/serviceSlot.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/bookings', getDateBookings);
router.get('/', getCrmSlots);
router.post('/', createSlot);
router.patch('/:id', updateSlot);
router.delete('/:id', deleteSlot);

export default router;
