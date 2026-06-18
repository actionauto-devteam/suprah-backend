import express from 'express';
import auth from '../middleware/auth.middleware';
import {
  getMyMembership,
  getAllTiers,
  getMyHistory,
  generateDiscountToken,
  verifyDiscountToken,
  discountTokenLimiter,
} from '../controllers/membership.controller';

const router = express.Router();

router.get('/tiers', getAllTiers);

router.use(auth());

router.get('/me', getMyMembership);
router.get('/history', getMyHistory);
router.post('/generate-discount-token', discountTokenLimiter, generateDiscountToken);
router.post('/verify-discount-token', verifyDiscountToken);

export default router;
