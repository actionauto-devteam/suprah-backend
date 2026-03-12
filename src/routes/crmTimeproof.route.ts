import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  getMyTimeproof,
  getAllUsersTimeproof,
  getUserTimeproof,
  exportTimeproof,
} from '../controllers/crmTimeproof.controller';

const router = express.Router();

// All timeproof routes require CRM authentication
router.use(crmAuth());

router.get('/my', getMyTimeproof);
router.get('/users', getAllUsersTimeproof);
router.get('/user/:userId', getUserTimeproof);
router.get('/export', exportTimeproof);

export default router;