import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import garageReviewController from '../controllers/garageReview.controller';

const router = express.Router();

// CRM-token auth (same gate as the Finance Line / aftermarket CRM routes)
router.use(crmAuth());

// ─── Lookups for the review screen ────────────────────────────────────────────
router.get('/inventory', garageReviewController.getInventory);
router.get('/customers', garageReviewController.getCustomers);
router.get('/deals',     garageReviewController.getTransferableDeals);

// ─── History ──────────────────────────────────────────────────────────────────
router.get('/transfers', garageReviewController.getTransfers);

// ─── The transfer action ────────────────────────────────────────────────────────
router.post('/transfer', garageReviewController.transferVehicle);

export default router;