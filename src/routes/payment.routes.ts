import express from 'express';
import paymentController from '../controllers/payment.controller';
import auth from '../middleware/auth.middleware';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook — MUST stay unauthenticated and receive the RAW request body.
//
// Stripe signature verification reads `req.rawBody`. That raw buffer is captured
// in your app bootstrap, typically via the express.json verify hook, e.g.:
//
//   app.use(express.json({
//     verify: (req, _res, buf) => { (req as any).rawBody = buf; },
//   }));
//
// If you instead mount the webhook with express.raw(), point the controller at
// req.body. Keep this route ABOVE any auth middleware.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/webhook', paymentController.handleStripeWebhook);

// Everything below requires an authenticated user (sets req.user + req.orgId).
router.use(auth());

// ─── Customer-facing (portal) ────────────────────────────────────────────────
// Declared before "/:id" so literal segments are never captured as an id.
router.get('/my-payments', paymentController.getMyPaymentsAsCustomer);

// Legacy Stripe Elements flow (kept for backward compatibility).
router.post('/create-customer-intent', paymentController.createCustomerPaymentIntent);
router.post('/confirm-customer', paymentController.confirmCustomerPayment);

// NEW — hosted Stripe Checkout flow (used by Pay Now + Buy Now).
router.post('/create-customer-checkout', paymentController.createCustomerCheckoutSession);
router.get('/checkout-session/:sessionId', paymentController.getCheckoutSessionStatus);

// ─── Dealer / CRM management ──────────────────────────────────────────────────
// NOTE: if you gate management actions by role, add your role middleware here
// (e.g. router.use(requireRole('admin','manager'))) — the controller already
// scopes every query by req.orgId.
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