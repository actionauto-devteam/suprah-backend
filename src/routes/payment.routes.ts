import express from 'express';
import paymentController from '../controllers/payment.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// Stripe webhook (must be BEFORE auth middleware - uses raw body)
router.post('/webhook', paymentController.handleStripeWebhook);

// All other routes require authentication
router.use(auth());
router.use(requireOrg);

router
  .route('/')
  .post(paymentController.createPayment)
  .get(paymentController.getPayments);

router.get('/pending', paymentController.getPendingPayments);
router.get('/stats', paymentController.getPaymentStats);

router.post('/create-intent', paymentController.createPaymentIntent);
router.post('/confirm', paymentController.confirmPayment);

router
  .route('/:id')
  .get(paymentController.getPaymentById)
  .patch(paymentController.updatePayment);

router.post('/:id/cancel', paymentController.cancelPayment);
router.post('/:id/refund', paymentController.refundPayment);

export default router;