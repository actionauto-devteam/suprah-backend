import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  createPhoneNumberHandler,
  deletePhoneNumberHandler,
  listPhoneNumbersHandler,
  recheckPhoneNumberHandler,
  updatePhoneNumberHandler,
} from '../controllers/dealershipPhoneNumber.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', listPhoneNumbersHandler);
router.post('/', createPhoneNumberHandler);
router.patch('/:id', updatePhoneNumberHandler);
router.post('/:id/check', recheckPhoneNumberHandler);
router.delete('/:id', deletePhoneNumberHandler);

export default router;
