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

// ─── Auth gate ────────────────────────────────────────────────────────────────
router.use(auth());

// ─── Browse ───────────────────────────────────────────────────────────────────
router.get('/', aftermarketController.getProductsForCustomer);

// ─── Orders ── declare before /:productId so 'orders' isn't captured ─────────
router.get('/orders/mine', aftermarketController.getMyOrders);
router.post('/checkout', aftermarketController.checkout);

// ─── Inquiries (mine) — declare before /:productId too ───────────────────────
router.get('/inquiries/mine', getMyInquiries);

// ─── Single product ───────────────────────────────────────────────────────────
router.get('/:id', aftermarketController.getProductById);

// ─── Direct purchase (priced products → ready-to-pay invoice) ────────────────
//   POST /api/aftermarket/:productId/buy-now   Body: { quantity? }
router.post('/:productId/buy-now', aftermarketController.buyNow);

// ─── Reviews ── per-product sub-resource ─────────────────────────────────────
router.get('/:productId/reviews',        getProductReviews);
router.post('/:productId/reviews',       submitReview);
router.delete('/:productId/reviews/mine', deleteMyReview);

// ─── Inquiries ── per-product ─────────────────────────────────────────────────
router.post('/:productId/inquiries', submitInquiry);

export default router;