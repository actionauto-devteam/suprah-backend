import express from 'express';
import multer from 'multer';
import aftermarketController from '../controllers/aftermarket.controller';
import {
  adminToggleReviewVisibility,
  adminListReviews,
} from '../controllers/aftermarketReview.controller';
import {
  adminListInquiries,
  adminUpdateInquiryStatus,
  adminGetInquiryDetail,
  adminCreateInvoiceForInquiry,
  adminInquiriesUnreadCount,
} from '../controllers/aftermarketInquiry.controller';
import crmAuth from '../middleware/crmAuth.middleware';
import { ApiError } from '../utils/ApiError';

const router = express.Router();

// ─── Multer: product media / file uploads ─────────────────────────────────────

const PRODUCT_MAX_FILE_SIZE = 40 * 1024 * 1024; // 40 MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PRODUCT_MAX_FILE_SIZE, files: 2 },
});

const uploadProductFiles = (req: any, res: any, next: any) => {
  upload.fields([
    { name: 'media', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ])(req, res, (err: any) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(400, 'File must be 40 MB or smaller.'));
    }
    return next(new ApiError(400, err?.message || 'File processing failed.'));
  });
};

// ─── Auth gate ────────────────────────────────────────────────────────────────

router.use(crmAuth());

router.get('/inquiries',                       adminListInquiries);
router.get('/inquiries/unread-count',          adminInquiriesUnreadCount);
router.get('/inquiries/:inquiryId',            adminGetInquiryDetail);
router.post('/inquiries/:inquiryId/invoice',   adminCreateInvoiceForInquiry);
router.patch('/inquiries/:inquiryId',          adminUpdateInquiryStatus);

// ─── Review moderation ────────────────────────────────────────────────────────
router.get('/:productId/reviews',              adminListReviews);
router.patch('/reviews/:reviewId',             adminToggleReviewVisibility);

// ─── Order status (legacy cart orders) ────────────────────────────────────────
router.patch('/orders/:id/status',             aftermarketController.updateOrderStatus);

// ─── Product CRUD ─────────────────────────────────────────────────────────────
router.get('/',           aftermarketController.getProductsForCrm);
router.post('/',          uploadProductFiles, aftermarketController.createProduct);
router.patch('/:id',      uploadProductFiles, aftermarketController.updateProduct);
router.delete('/:id',     aftermarketController.deleteProduct);

export default router;