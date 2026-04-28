import { Request, Response } from 'express';
import Stripe from 'stripe';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { safeCreateNotification, notifyOrgAdmins } from '../utils/safeNotification';
import Payment from '../models/Payment.model';
import User, { IUser } from '../models/User.model';
import config from '../config';
import ReferralService from '../services/referral.service';
import logger from '../utils/logger';
import activityService from '../services/activity.service';

const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2026-01-28.clover',
});

const getUserId = (req: Request): string => {
  const userId = (req.user as IUser)?._id?.toString();
  if (!userId) throw new ApiError(401, 'User not authenticated');
  return userId;
};

// ─── Create Payment ───────────────────────────────────────────────────────────
const createPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const {
    customerName, customerEmail, customerPhone,
    amount, currency = 'usd', description,
    quoteId, shipmentId, dueDate, notes,
  } = req.body;

  if (!customerName || !customerEmail || !amount || !description) {
    throw new ApiError(400, 'customerName, customerEmail, amount, and description are required');
  }
  if (amount <= 0) throw new ApiError(400, 'Amount must be greater than zero');

  const payment = await Payment.create({
    organizationId: orgId,
    customerId: customerEmail,
    customerName,
    customerEmail: customerEmail.toLowerCase(),
    customerPhone,
    amount,
    currency,
    description,
    status: 'pending',
    quoteId,
    shipmentId,
    dueDate: dueDate ? new Date(dueDate) : undefined,
    notes,
    createdBy: userId,
  });

  notifyOrgAdmins(
    orgId, 'payment_pending', 'New Payment Created',
    `A payment of $${amount.toFixed(2)} for ${customerName} is pending.`,
    { paymentId: payment._id.toString(), amount, customerName }
  );

  logger.info({ paymentId: payment._id, amount, customerEmail }, 'Payment record created');

  res.status(201).json(new ApiResponse(201, payment, 'Payment record created successfully'));
});

// ─── Get Payments ─────────────────────────────────────────────────────────────
const getPayments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { status, search, limit = '50', skip = '0' } = req.query;

  const filter: Record<string, unknown> = { organizationId: orgId };
  if (status && status !== 'all') filter.status = status;

  // Push search to DB when possible
  if (search) {
    const regex = new RegExp(search as string, 'i');
    filter.$or = [
      { customerName: regex },
      { customerEmail: regex },
      { invoiceNumber: regex },
      { description: regex },
    ];
  }

  const [payments, total] = await Promise.all([
    Payment.find(filter)
      .populate('quoteId', 'firstName lastName vehicleName')
      .populate('shipmentId', 'trackingNumber')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit as string))
      .skip(parseInt(skip as string))
      .lean(),
    Payment.countDocuments(filter),
  ]);

  res.json(new ApiResponse(200, { payments, total }, 'Payments fetched successfully'));
});

// ─── Get Pending Payments ─────────────────────────────────────────────────────
const getPendingPayments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const payments = await Payment.find({
    organizationId: orgId,
    status: { $in: ['pending', 'failed'] },
  })
    .populate('quoteId', 'firstName lastName vehicleName')
    .populate('shipmentId', 'trackingNumber')
    .sort({ dueDate: 1, createdAt: -1 })
    .lean();

  res.json(new ApiResponse(200, payments, 'Pending payments fetched successfully'));
});

// ─── Get Payment by ID ────────────────────────────────────────────────────────
const getPaymentById = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId })
    .populate('quoteId', 'firstName lastName vehicleName fromAddress toAddress')
    .populate('shipmentId', 'trackingNumber status')
    .populate('createdBy', 'name email');

  if (!payment) throw new ApiError(404, 'Payment not found');

  res.json(new ApiResponse(200, payment, 'Payment fetched successfully'));
});

// ─── Create Payment Intent ────────────────────────────────────────────────────
const createPaymentIntent = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { paymentId } = req.body;

  if (!paymentId) throw new ApiError(400, 'paymentId is required');

  const payment = await Payment.findOne({ _id: paymentId, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status === 'succeeded') throw new ApiError(400, 'This payment has already been completed');
  if (payment.status === 'cancelled') throw new ApiError(400, 'This payment has been cancelled');

  // Reuse existing intent if valid
  if (payment.stripePaymentIntentId) {
    try {
      const existing = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      if (existing.status !== 'canceled' && existing.status !== 'succeeded') {
        return res.json(new ApiResponse(200, {
          clientSecret: existing.client_secret,
          paymentIntentId: existing.id,
        }, 'Existing payment intent retrieved'));
      }
    } catch { /* expired — create new */ }
  }

  let stripeCustomerId = payment.stripeCustomerId;
  if (!stripeCustomerId) {
    const customers = await stripe.customers.list({ email: payment.customerEmail, limit: 1 });
    stripeCustomerId = customers.data.length > 0
      ? customers.data[0].id
      : (await stripe.customers.create({
        name: payment.customerName,
        email: payment.customerEmail,
        phone: payment.customerPhone,
        metadata: { organizationId: orgId },
      })).id;
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(payment.amount * 100),
    currency: payment.currency,
    customer: stripeCustomerId,
    description: payment.description,
    metadata: {
      paymentId: payment._id.toString(),
      organizationId: orgId,
      invoiceNumber: payment.invoiceNumber || '',
    },
    automatic_payment_methods: { enabled: true },
  });

  await Payment.findByIdAndUpdate(payment._id, {
    stripePaymentIntentId: paymentIntent.id,
    stripeCustomerId,
    status: 'processing',
  });

  res.json(new ApiResponse(200, {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  }, 'Payment intent created successfully'));
});

// ─── Confirm Payment ──────────────────────────────────────────────────────────
const confirmPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const { paymentIntentId } = req.body;

  if (!paymentIntentId) throw new ApiError(400, 'paymentIntentId is required');

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  const payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment record not found');

  // Idempotency: already confirmed
  if (payment.status === 'succeeded') {
    return res.json(new ApiResponse(200, payment, 'Payment already confirmed'));
  }

  if (paymentIntent.status === 'succeeded') {
    payment.status = 'succeeded';
    payment.paidAt = new Date();
    payment.stripeChargeId = paymentIntent.latest_charge as string;

    if (payment.stripeChargeId) {
      try {
        const charge = await stripe.charges.retrieve(payment.stripeChargeId);
        payment.receiptUrl = charge.receipt_url || undefined;
        payment.paymentMethod = charge.payment_method_details?.type || undefined;
      } catch { /* non-critical */ }
    }

    await payment.save();

    await safeCreateNotification({
      userId,
      organizationId: orgId,
      type: 'payment_received',
      title: 'Payment Received',
      message: `Payment of $${payment.amount.toFixed(2)} from ${payment.customerName} was successful.`,
      metadata: { paymentId: payment._id.toString(), amount: payment.amount, customerName: payment.customerName },
    });

    await activityService.logFinancialActivity(
      userId,
      orgId,
      'payment_completed',
      payment.amount,
      `Payment of $${payment.amount.toFixed(2)} confirmed from ${payment.customerName}`,
      { paymentId: payment._id.toString(), stripeChargeId: payment.stripeChargeId }
    );

    logger.info({ paymentId: payment._id, amount: payment.amount }, 'Payment confirmed successfully');

    return res.json(new ApiResponse(200, payment, 'Payment confirmed successfully'));
  }

  if (paymentIntent.status === 'requires_payment_method') {
    payment.status = 'failed';
    payment.failureReason = paymentIntent.last_payment_error?.message || 'Payment method failed';
    await payment.save();
    return res.json(new ApiResponse(200, payment, 'Payment failed - new payment method required'));
  }

  payment.status = paymentIntent.status === 'canceled' ? 'cancelled' : 'processing';
  await payment.save();
  res.json(new ApiResponse(200, payment, `Payment status: ${paymentIntent.status}`));
});

// ─── Cancel Payment ───────────────────────────────────────────────────────────
const cancelPayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status === 'succeeded') throw new ApiError(400, 'Cannot cancel a completed payment. Use refund instead.');

  if (payment.stripePaymentIntentId) {
    try { await stripe.paymentIntents.cancel(payment.stripePaymentIntentId); } catch { /* already cancelled */ }
  }

  payment.status = 'cancelled';
  await payment.save();

  notifyOrgAdmins(orgId, 'general', 'Payment Cancelled',
    `Payment of $${payment.amount.toFixed(2)} for ${payment.customerName} was cancelled.`,
    { paymentId: payment._id.toString() }
  );

  logger.info({ paymentId: payment._id }, 'Payment cancelled');

  res.json(new ApiResponse(200, payment, 'Payment cancelled successfully'));
});

// ─── Refund Payment ───────────────────────────────────────────────────────────
const refundPayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;
  const { amount } = req.body;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status !== 'succeeded') throw new ApiError(400, 'Can only refund completed payments');
  if (!payment.stripePaymentIntentId) throw new ApiError(400, 'No Stripe payment intent found');

  const refundParams: Stripe.RefundCreateParams = { payment_intent: payment.stripePaymentIntentId };
  if (amount) refundParams.amount = Math.round(amount * 100);

  await stripe.refunds.create(refundParams);

  payment.status = 'refunded';
  await payment.save();

  notifyOrgAdmins(orgId, 'general', 'Payment Refunded',
    `Payment of $${payment.amount.toFixed(2)} for ${payment.customerName} has been refunded.`,
    { paymentId: payment._id.toString() }
  );

  await activityService.createActivity({
    userId: (req.user?._id as any).toString(),
    organizationId: orgId,
    type: 'wallet_adjustment',
    title: 'Payment Refunded',
    description: `Refund of $${(amount || payment.amount).toFixed(2)} processed for ${payment.customerName}`,
    metadata: { paymentId: payment._id.toString(), refundAmount: amount || payment.amount }
  });

  logger.info({ paymentId: payment._id, amount: amount || payment.amount }, 'Payment refunded');

  res.json(new ApiResponse(200, payment, 'Payment refunded successfully'));
});

// ─── Update Payment ───────────────────────────────────────────────────────────
const updatePayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;
  const { status, notes, dueDate } = req.body;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');

  const validStatuses = ['pending', 'processing', 'succeeded', 'failed', 'refunded', 'cancelled'];
  const previousStatus = payment.status;

  if (status !== undefined) {
    if (!validStatuses.includes(status)) {
      throw new ApiError(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
    payment.status = status;
    if (status === 'succeeded' && !payment.paidAt) payment.paidAt = new Date();
  }

  if (notes !== undefined) payment.notes = notes;
  if (dueDate !== undefined) payment.dueDate = dueDate ? new Date(dueDate) : undefined;

  await payment.save();

  // FIX: check previousStatus BEFORE save so isModified isn't needed
  if (previousStatus !== 'succeeded' && payment.status === 'succeeded') {
    try {
      const performingUserId = (req.user as IUser)?._id?.toString();
      await ReferralService.processPaymentReward(payment, performingUserId || 'MANUAL');
    } catch (e) { console.error('[Referral] updatePayment:', e); }
  }

  res.json(new ApiResponse(200, payment, 'Payment updated successfully'));
});

// ─── Payment Stats ────────────────────────────────────────────────────────────
const getPaymentStats = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const stats = await Payment.aggregate([
    { $match: { organizationId: orgId } },
    { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } },
  ]);

  const formatted: Record<string, { count: number; totalAmount: number }> = {
    pending: { count: 0, totalAmount: 0 }, processing: { count: 0, totalAmount: 0 },
    succeeded: { count: 0, totalAmount: 0 }, failed: { count: 0, totalAmount: 0 },
    refunded: { count: 0, totalAmount: 0 }, cancelled: { count: 0, totalAmount: 0 },
  };

  let totalCount = 0;
  let totalRevenue = 0;

  stats.forEach((s) => {
    if (formatted[s._id]) {
      formatted[s._id] = { count: s.count, totalAmount: s.totalAmount };
      totalCount += s.count;
      if (s._id === 'succeeded') totalRevenue = s.totalAmount;
    }
  });

  res.json(new ApiResponse(200, {
    byStatus: formatted,
    totalCount,
    totalRevenue,
    pendingAmount: formatted.pending.totalAmount + formatted.failed.totalAmount,
  }, 'Payment statistics fetched successfully'));
});

// ─── Billing Balance (NEW — fixes the 404 on dashboard) ──────────────────────
const getBillingBalance = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const result = await Payment.aggregate([
    { $match: { organizationId: orgId, status: 'succeeded' } },
    { $group: { _id: null, balance: { $sum: '$amount' } } },
  ]);

  const balance = result[0]?.balance ?? 0;
  res.json(new ApiResponse(200, { balance }, 'Balance fetched successfully'));
});

// ─── Stripe Webhook ───────────────────────────────────────────────────────────
const handleStripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;
  if (!sig) throw new ApiError(400, 'Missing Stripe signature');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent((req as any).rawBody, sig, config.stripe.webhookSecret);
  } catch (err: any) {
    throw new ApiError(400, `Webhook signature verification failed: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const payment = await Payment.findOne({ stripePaymentIntentId: pi.id });
      // Idempotency guard
      if (payment && payment.status !== 'succeeded') {
        payment.status = 'succeeded';
        payment.paidAt = new Date();
        payment.stripeChargeId = pi.latest_charge as string;
        await payment.save();
        await activityService.createActivity({
          userId: 'SYSTEM',
          organizationId: payment.organizationId.toString(),
          type: 'payment_completed',
          title: 'Payment Succeeded (Webhook)',
          description: `Webhook confirmation: $${payment.amount.toFixed(2)} received`,
          metadata: { paymentId: payment._id.toString(), piId: pi.id }
        });
        logger.info({ paymentId: payment._id, piId: pi.id }, 'Stripe Webhook: Payment success');

        try { await ReferralService.processPaymentReward(payment, 'STRIPE_WEBHOOK'); } catch (e) {
          logger.error({ err: e, paymentId: payment._id }, 'Referral processing failed during webhook');
        }
      }
      break;
    }
    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const payment = await Payment.findOne({ stripePaymentIntentId: pi.id });
      if (payment && payment.status !== 'succeeded') {
        payment.status = 'failed';
        payment.failureReason = pi.last_payment_error?.message || 'Payment failed';
        await payment.save();
      }
      break;
    }
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      if (charge.payment_intent) {
        await Payment.findOneAndUpdate(
          { stripePaymentIntentId: charge.payment_intent },
          { status: 'refunded' }
        );
      }
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
});

// ─── Request Payment from Customer ───────────────────────────────────────────
const requestPaymentFromCustomer = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status === 'succeeded') throw new ApiError(400, 'This payment has already been completed');

  const customer = await User.findOne({ email: payment.customerEmail.toLowerCase() });
  if (!customer) {
    throw new ApiError(404, 'Customer has not registered an account yet. Ask them to sign up first.');
  }

  const dealer = req.user as IUser;
  const dealerName = dealer?.name || 'the dealer';

  await safeCreateNotification({
    userId: customer._id as any,
    organizationId: orgId,
    type: 'payment_request',
    title: 'Payment Request',
    message: `You have a pending payment of $${payment.amount.toFixed(2)} for "${payment.description}" from ${dealerName}. Please log in to complete your payment.`,
    metadata: {
      paymentId: payment._id.toString(),
      amount: payment.amount,
      description: payment.description,
      invoiceNumber: payment.invoiceNumber,
    },
  });

  res.json(new ApiResponse(200, null, 'Payment request sent to customer successfully'));
});

// ─── Customer: My Payments ────────────────────────────────────────────────────
const getMyPaymentsAsCustomer = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const payments = await Payment.find({ customerEmail: user.email.toLowerCase() })
    .sort({ createdAt: -1 })
    .lean();

  const totalOwed = payments.filter(p => p.status === 'pending' || p.status === 'failed').reduce((s, p) => s + p.amount, 0);
  const totalPaid = payments.filter(p => p.status === 'succeeded').reduce((s, p) => s + p.amount, 0);
  const pendingCount = payments.filter(p => p.status === 'pending' || p.status === 'failed').length;

  res.json(new ApiResponse(200, {
    payments, stats: { totalOwed, totalPaid, pendingCount },
  }, 'Payments fetched successfully'));
});

// ─── Customer: Create Payment Intent ─────────────────────────────────────────
const createCustomerPaymentIntent = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const { paymentId } = req.body;
  if (!paymentId) throw new ApiError(400, 'paymentId is required');

  const payment = await Payment.findById(paymentId);
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.customerEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError(403, 'You are not authorized to pay this invoice');
  }
  if (payment.status === 'succeeded') throw new ApiError(400, 'This payment has already been completed');
  if (payment.status === 'cancelled') throw new ApiError(400, 'This payment has been cancelled');

  if (payment.stripePaymentIntentId) {
    try {
      const existing = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      if (existing.status !== 'canceled' && existing.status !== 'succeeded') {
        return res.json(new ApiResponse(200, {
          clientSecret: existing.client_secret,
          paymentIntentId: existing.id,
        }, 'Existing payment intent retrieved'));
      }
    } catch { /* create new */ }
  }

  let stripeCustomerId = payment.stripeCustomerId;
  if (!stripeCustomerId) {
    const customers = await stripe.customers.list({ email: payment.customerEmail, limit: 1 });
    stripeCustomerId = customers.data.length > 0
      ? customers.data[0].id
      : (await stripe.customers.create({
        name: payment.customerName,
        email: payment.customerEmail,
        phone: payment.customerPhone,
      })).id;
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(payment.amount * 100),
    currency: payment.currency,
    customer: stripeCustomerId,
    description: payment.description,
    metadata: { paymentId: payment._id.toString(), invoiceNumber: payment.invoiceNumber || '' },
    automatic_payment_methods: { enabled: true },
  });

  await Payment.findByIdAndUpdate(payment._id, {
    stripePaymentIntentId: paymentIntent.id,
    stripeCustomerId,
    status: 'processing',
  });

  res.json(new ApiResponse(200, {
    clientSecret: paymentIntent.client_secret,
    paymentIntentId: paymentIntent.id,
  }, 'Payment intent created successfully'));
});

// ─── Customer: Confirm Payment ────────────────────────────────────────────────
const confirmCustomerPayment = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const { paymentIntentId } = req.body;
  if (!paymentIntentId) throw new ApiError(400, 'paymentIntentId is required');

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId });
  if (!payment) throw new ApiError(404, 'Payment record not found');
  if (payment.customerEmail.toLowerCase() !== user.email.toLowerCase()) throw new ApiError(403, 'Not authorized');

  // Idempotency
  if (payment.status === 'succeeded') {
    return res.json(new ApiResponse(200, payment, 'Payment already confirmed'));
  }

  if (paymentIntent.status === 'succeeded') {
    payment.status = 'succeeded';
    payment.paidAt = new Date();
    payment.stripeChargeId = paymentIntent.latest_charge as string;

    if (payment.stripeChargeId) {
      try {
        const charge = await stripe.charges.retrieve(payment.stripeChargeId);
        payment.receiptUrl = charge.receipt_url || undefined;
        payment.paymentMethod = charge.payment_method_details?.type || undefined;
      } catch { /* non-critical */ }
    }

    await payment.save();

    try { await ReferralService.processPaymentReward(payment, user._id.toString()); } catch (e) {
      logger.error({ err: e, paymentId: payment._id }, 'Referral processing failed during customer confirmation');
    }

    await activityService.logFinancialActivity(
      user._id.toString(),
      payment.organizationId?.toString(),
      'payment_completed',
      payment.amount,
      `Customer payment of $${payment.amount.toFixed(2)} confirmed`,
      { paymentId: payment._id.toString(), stripeChargeId: payment.stripeChargeId }
    );

    logger.info({ paymentId: payment._id, userId: user._id }, 'Customer payment confirmed');

    await safeCreateNotification({
      userId: payment.createdBy as any,
      organizationId: payment.organizationId,
      type: 'payment_received',
      title: 'Payment Received',
      message: `Payment of $${payment.amount.toFixed(2)} from ${payment.customerName} was successful.`,
      metadata: { paymentId: payment._id.toString(), amount: payment.amount, customerName: payment.customerName },
    });

    return res.json(new ApiResponse(200, payment, 'Payment confirmed successfully'));
  }

  if (paymentIntent.status === 'requires_payment_method') {
    payment.status = 'failed';
    payment.failureReason = paymentIntent.last_payment_error?.message || 'Payment method failed';
    await payment.save();
    return res.json(new ApiResponse(200, payment, 'Payment failed'));
  }

  payment.status = paymentIntent.status === 'canceled' ? 'cancelled' : 'processing';
  await payment.save();
  res.json(new ApiResponse(200, payment, `Payment status: ${paymentIntent.status}`));
});

export default {
  createPayment,
  getPayments,
  getPendingPayments,
  getPaymentById,
  updatePayment,
  createPaymentIntent,
  confirmPayment,
  cancelPayment,
  refundPayment,
  getPaymentStats,
  getBillingBalance,
  handleStripeWebhook,
  requestPaymentFromCustomer,
  getMyPaymentsAsCustomer,
  createCustomerPaymentIntent,
  confirmCustomerPayment,
};