import express from 'express';
import crmAuth from '../middleware/crmAuth.middleware';
import garageReviewController from '../controllers/garageReview.controller';

const router = express.Router();

router.use(crmAuth());

router.get('/inventory', garageReviewController.getInventory);
router.get('/customers', garageReviewController.getCustomers);
router.get('/deals',     garageReviewController.getTransferableDeals);

router.get('/transfers', garageReviewController.getTransfers);

router.post('/transfer', garageReviewController.transferVehicle);

export default router;