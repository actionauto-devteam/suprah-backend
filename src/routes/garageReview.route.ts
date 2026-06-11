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

// ─── Service queue ────────────────────────────────────────────────────────────
router.get('/service/queue',                                  garageReviewController.getServiceQueue);
router.get('/service/customer-vehicles/:customerId',          garageReviewController.getCustomerVehiclesForService);
router.post('/service/checkin',                               garageReviewController.checkInVehicle);
router.patch('/service/status/:serviceId',                    garageReviewController.updateQueueServiceStatus);

export default router;