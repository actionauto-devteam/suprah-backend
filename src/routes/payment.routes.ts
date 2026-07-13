import express from 'express';
import paymentController from '../controllers/payment.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

router.post('/webhook', paymentController.handleStripeWebhook);

router.use(auth());

router.get('/my-payments', paymentController.getMyPaymentsAsCustomer);

router.post('/create-customer-intent', paymentController.createCustomerPaymentIntent);
router.post('/confirm-customer', paymentController.confirmCustomerPayment);

router.post('/create-customer-checkout', paymentController.createCustomerCheckoutSession);
router.get('/checkout-session/:sessionId', paymentController.getCheckoutSessionStatus);

router.post('/:id/cancel-mine', paymentController.cancelMyPayment);

router.get('/stats', paymentController.getPaymentStats);
router.get('/balance', paymentController.getBillingBalance);
router.get('/pending', paymentController.getPendingPayments);

router.get('/', paymentController.getPayments);
router.post('/', paymentController.createPayment);

router.post('/create-intent', paymentController.createPaymentIntent);
router.post('/confirm', paymentController.confirmPayment);

router.get('/:id', paymentController.getPaymentById);
router.patch('/:id', paymentController.updatePayment);
router.post('/:id/cancel', paymentController.cancelPayment);
router.post('/:id/refund', paymentController.refundPayment);
router.post('/:id/request', paymentController.requestPaymentFromCustomer);

export default router;