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
// All customer aftermarket routes use the standard auth() middleware —
// identical to the existing setup. It populates req.user and req.orgId.
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

// ─── Reviews ── per-product sub-resource ─────────────────────────────────────
//
//   GET    /api/aftermarket/:productId/reviews          public list + summary
//   POST   /api/aftermarket/:productId/reviews          submit a review
//   DELETE /api/aftermarket/:productId/reviews/mine     remove own review
//
router.get('/:productId/reviews',        getProductReviews);
router.post('/:productId/reviews',       submitReview);
router.delete('/:productId/reviews/mine', deleteMyReview);

// ─── Inquiries ── per-product ─────────────────────────────────────────────────
//
//   POST   /api/aftermarket/:productId/inquiries        submit a question
//
router.post('/:productId/inquiries', submitInquiry);

export default router;