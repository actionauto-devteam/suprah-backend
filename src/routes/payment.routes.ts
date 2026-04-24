import express from 'express';
import paymentController from '../controllers/payment.controller';
import auth from '../middleware/auth.middleware';
import { requireOrg } from '../middleware/org.middleware';

const router = express.Router();

// ── Stripe webhook (raw body, no auth) ───────────────────────────────────────
router.post('/webhook', paymentController.handleStripeWebhook);

// ── Customer-facing routes (auth only, no org) ───────────────────────────────
router.get('/my-payments', auth(), paymentController.getMyPaymentsAsCustomer);
router.post('/create-customer-intent', auth(), paymentController.createCustomerPaymentIntent);
router.post('/confirm-customer', auth(), paymentController.confirmCustomerPayment);

// ── All other routes require auth + org ──────────────────────────────────────
router.use(auth());
router.use(requireOrg);

router.route('/').post(paymentController.createPayment).get(paymentController.getPayments);
router.get('/pending', paymentController.getPendingPayments);
router.get('/stats', paymentController.getPaymentStats);

// FIX: balance endpoint — was being called as /api/billing/balance which didn't exist
router.get('/balance', paymentController.getBillingBalance);

router.post('/create-intent', paymentController.createPaymentIntent);
router.post('/confirm', paymentController.confirmPayment);

router.route('/:id').get(paymentController.getPaymentById).patch(paymentController.updatePayment);
router.post('/:id/cancel', paymentController.cancelPayment);
router.post('/:id/refund', paymentController.refundPayment);
router.post('/:id/request', paymentController.requestPaymentFromCustomer);

export default router;