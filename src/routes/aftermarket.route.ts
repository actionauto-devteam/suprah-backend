import express from 'express';
import aftermarketController from '../controllers/aftermarket.controller';
import {
  submitReview,
  getProductReviews,
  deleteMyReview,
} from '../controllers/aftermarketReview.controller';
import {
  submitInquiry,
  getMyInquiries,
} from '../controllers/aftermarketInquiry.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.use(auth());

router.get('/', aftermarketController.getProductsForCustomer);

router.get('/orders/mine', aftermarketController.getMyOrders);
router.post('/checkout', aftermarketController.checkout);

router.get('/inquiries/mine', getMyInquiries);

router.get('/:id', aftermarketController.getProductById);

router.post('/:productId/buy-now', aftermarketController.buyNow);

router.get('/:productId/reviews',        getProductReviews);
router.post('/:productId/reviews',       submitReview);
router.delete('/:productId/reviews/mine', deleteMyReview);

router.post('/:productId/inquiries', submitInquiry);

export default router;