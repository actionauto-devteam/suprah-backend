import express from 'express';
import paymentController from '../controllers/payment.controller';
import auth from '../middleware/auth.middleware';
import authorize from '../middleware/role.middleware';

const router = express.Router();

router.post('/webhook', paymentController.handleStripeWebhook);

router.use(auth());

router.get('/my-payments', paymentController.getMyPaymentsAsCustomer);

router.post('/create-customer-intent', paymentController.createCustomerPaymentIntent);
router.post('/confirm-customer', paymentController.confirmCustomerPayment);

router.post('/create-customer-checkout', paymentController.createCustomerCheckoutSession);
router.get('/checkout-session/:sessionId', paymentController.getCheckoutSessionStatus);

router.post('/:id/cancel-mine', paymentController.cancelMyPayment);
router.post('/:id/left-checkout', paymentController.leaveCheckout);

// Everything below works on the dealership's own payment records (the list,
// totals, sending requests, refunds), so only its staff may use it. Customers
// use the routes above, which only touch invoices sent to their own email.
router.use(
  authorize(
    ['super_admin', 'admin', 'employee'],
    "Only your dealership's staff can view or manage payments.",
  ),
);

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