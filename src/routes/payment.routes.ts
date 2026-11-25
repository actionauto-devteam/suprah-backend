import express from 'express';
import paymentController from '../controllers/payment.controller';
import auth from '../middleware/auth.middleware';
import authorize from '../middleware/role.middleware';
import { getDealershipSettings, updateDealershipSettings } from '../controllers/suprahPaySettings.controller';
import { requireFinanceAccess } from '../utils/financeAccess';
import {
  connectDealershipPayoutAccount,
  getDealershipPayoutAccount,
  getDealershipPayouts,
} from '../controllers/dealershipPayouts.controller';

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
// Back on SuprahPay after Stripe's page (2026-11-25).
router.post('/checkout-return', paymentController.returnFromCheckout);

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

// The dealership's SuprahPay settings (2026-11-21): any staff can read them; admins change them.
router.get('/settings', getDealershipSettings);
router.put(
  '/settings',
  authorize(['super_admin', 'admin'], "Only your dealership's admins can change SuprahPay settings."),
  updateDealershipSettings,
);

// Suprah's weekly payouts to the dealership (2026-11-21): staff can see them;
// only admins set up the Stripe payout account.
router.get('/payouts', getDealershipPayouts);
router.get('/payout-account', getDealershipPayoutAccount);
router.post(
  '/payout-account/connect',
  authorize(['super_admin', 'admin'], "Only your dealership's admins can set up the payout account."),
  connectDealershipPayoutAccount,
);

// Shipping bills from Suprah for the dealership's own loads (2026-11-25).
router.get('/suprah-bills', paymentController.getSuprahBills);
router.post('/suprah-bills/:id/pay', requireFinanceAccess, paymentController.paySuprahBill);
router.post('/suprah-bills/:id/check', paymentController.checkSuprahBill);
router.get('/', paymentController.getPayments);
// Sending, editing, cancelling and refunding need Finance access (2026-11-21);
// every staff member can still view payments.
router.post('/', requireFinanceAccess, paymentController.createPayment);

router.post('/create-intent', requireFinanceAccess, paymentController.createPaymentIntent);
router.post('/confirm', requireFinanceAccess, paymentController.confirmPayment);

router.get('/:id', paymentController.getPaymentById);
router.patch('/:id', requireFinanceAccess, paymentController.updatePayment);
router.post('/:id/cancel', requireFinanceAccess, paymentController.cancelPayment);
router.post('/:id/refund', requireFinanceAccess, paymentController.refundPayment);
router.post('/:id/request', requireFinanceAccess, paymentController.requestPaymentFromCustomer);

export default router;