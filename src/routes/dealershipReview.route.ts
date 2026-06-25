import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import {
  getAllReviews,
  createReview,
  updateReview,
  deleteReview,
} from '../controllers/dealershipReview.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/', getAllReviews);
router.post('/', createReview);
router.patch('/:id', updateReview);
router.delete('/:id', deleteReview);

export default router;
