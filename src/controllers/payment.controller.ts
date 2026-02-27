import { Request, Response } from 'express';
import Stripe from 'stripe';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { safeCreateNotification } from '../utils/safeNotification';
import { notificationTemplates } from '../utils/notificationTemplates';
import Payment from '../models/Payment.model';
import { IUser } from '../models/User.model';
import config from '../config';

// Initialize Stripe
const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2026-01-28.clover',
});

/**
 * Helper to safely get user ID from request
 */
const getUserId = (req: Request): string => {
  const userId = (req.user as IUser)?._id?.toString();
  if (!userId) throw new ApiError(401, 'User not authenticated');
  return userId;
};

/**
 * Create a new pending payment record
 */
const createPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const {
    customerName,
    customerEmail,
    customerPhone,
    amount,
    currency = 'usd',
    description,
    quoteId,
    shipmentId,
    dueDate,
    notes,
  } = req.body;

  if (!customerName || !customerEmail || !amount || !description) {
    throw new ApiError(400, 'customerName, customerEmail, amount, and description are required');
  }

  if (amount <= 0) {
    throw new ApiError(400, 'Amount must be greater than zero');
  }

  const payment = await Payment.create({
    organizationId: orgId,
    customerId: customerEmail,
    customerName,
    customerEmail,
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

  res.status(201).json(
    new ApiResponse(201, payment, 'Payment record created successfully')
  );
});

/**
 * Get all payments for the organization (with filters)
 */
const getPayments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { status, search, limit = '50', skip = '0' } = req.query;

  const filter: any = { organizationId: orgId };

  if (status && status !== 'all') {
    filter.status = status;
  }

  let payments = await Payment.find(filter)
    .populate('quoteId', 'firstName lastName vehicleName')
    .populate('shipmentId', 'trackingNumber')
    .populate('createdBy', 'name email')
    .sort({ createdAt: -1 })
    .limit(parseInt(limit as string))
    .skip(parseInt(skip as string));

  // Client-side search filtering
  if (search) {
    const searchLower = (search as string).toLowerCase();
    payments = payments.filter((p) => {
      return (
        p.customerName?.toLowerCase().includes(searchLower) ||
        p.customerEmail?.toLowerCase().includes(searchLower) ||
        p.invoiceNumber?.toLowerCase().includes(searchLower) ||
        p.description?.toLowerCase().includes(searchLower)
      );
    });
  }

  const total = await Payment.countDocuments(filter);

  res.json(
    new ApiResponse(200, { payments, total }, 'Payments fetched successfully')
  );
});

/**
 * Get pending payments only (for billing sidebar)
 */
const getPendingPayments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const payments = await Payment.find({
    organizationId: orgId,
    status: { $in: ['pending', 'failed'] },
  })
    .populate('quoteId', 'firstName lastName vehicleName')
    .populate('shipmentId', 'trackingNumber')
    .sort({ dueDate: 1, createdAt: -1 });

  res.json(
    new ApiResponse(200, payments, 'Pending payments fetched successfully')
  );
});

/**
 * Get a single payment by ID
 */
const getPaymentById = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId })
    .populate('quoteId', 'firstName lastName vehicleName fromAddress toAddress')
    .populate('shipmentId', 'trackingNumber status')
    .populate('createdBy', 'name email');

  if (!payment) {
    throw new ApiError(404, 'Payment not found');
  }

  res.json(new ApiResponse(200, payment, 'Payment fetched successfully'));
});

/**
 * Create a Stripe PaymentIntent for a pending payment
 */
const createPaymentIntent = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { paymentId } = req.body;

  if (!paymentId) {
    throw new ApiError(400, 'paymentId is required');
  }

  const payment = await Payment.findOne({ _id: paymentId, organizationId: orgId });

  if (!payment) {
    throw new ApiError(404, 'Payment not found');
  }

  if (payment.status === 'succeeded') {
    throw new ApiError(400, 'This payment has already been completed');
  }

  if (payment.status === 'cancelled') {
    throw new ApiError(400, 'This payment has been cancelled');
  }

  // If a PaymentIntent already exists and is still valid, return it
  if (payment.stripePaymentIntentId) {
    try {
      const existingIntent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      if (existingIntent.status !== 'canceled' && existingIntent.status !== 'succeeded') {
        return res.json(
          new ApiResponse(200, {
            clientSecret: existingIntent.client_secret,
            paymentIntentId: existingIntent.id,
          }, 'Existing payment intent retrieved')
        );
      }
    } catch {
      // Intent no longer valid, create a new one
    }
  }

  // Create or get Stripe customer
  let stripeCustomerId = payment.stripeCustomerId;
  if (!stripeCustomerId) {
    const customers = await stripe.customers.list({
      email: payment.customerEmail,
      limit: 1,
    });

    if (customers.data.length > 0) {
      stripeCustomerId = customers.data[0].id;
    } else {
      const customer = await stripe.customers.create({
        name: payment.customerName,
        email: payment.customerEmail,
        phone: payment.customerPhone,
        metadata: {
          organizationId: orgId,
        },
      });
      stripeCustomerId = customer.id;
    }
  }

  // Create PaymentIntent (amount in cents)
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
    automatic_payment_methods: {
      enabled: true,
    },
  });

  // Update payment record
  payment.stripePaymentIntentId = paymentIntent.id;
  payment.stripeCustomerId = stripeCustomerId;
  payment.status = 'processing';
  await payment.save();

  res.json(
    new ApiResponse(200, {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    }, 'Payment intent created successfully')
  );
});

/**
 * Confirm payment was successful (called after Stripe confirms on client)
 */
const confirmPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const { paymentIntentId } = req.body;

  if (!paymentIntentId) {
    throw new ApiError(400, 'paymentIntentId is required');
  }

  // Verify with Stripe
  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

  const payment = await Payment.findOne({
    stripePaymentIntentId: paymentIntentId,
    organizationId: orgId,
  });

  if (!payment) {
    throw new ApiError(404, 'Payment record not found');
  }

  if (paymentIntent.status === 'succeeded') {
    payment.status = 'succeeded';
    payment.paidAt = new Date();
    payment.stripeChargeId = paymentIntent.latest_charge as string;

    // Get receipt URL if available
    if (payment.stripeChargeId) {
      try {
        const charge = await stripe.charges.retrieve(payment.stripeChargeId);
        payment.receiptUrl = charge.receipt_url || undefined;
        payment.paymentMethod = charge.payment_method_details?.type || undefined;
      } catch {
        // Non-critical, continue
      }
    }

    await payment.save();

    // Notification
    if (userId) {
      await safeCreateNotification({
        userId,
        organizationId: orgId,
        type: 'payment_received',
        title: 'Payment Received',
        message: `Payment of $${payment.amount.toFixed(2)} from ${payment.customerName} was successful.`,
        metadata: {
          paymentId: payment._id.toString(),
          amount: payment.amount,
          customerName: payment.customerName,
        },
      });
    }

    return res.json(
      new ApiResponse(200, payment, 'Payment confirmed successfully')
    );
  }

  if (paymentIntent.status === 'requires_payment_method') {
    payment.status = 'failed';
    payment.failureReason = paymentIntent.last_payment_error?.message || 'Payment method failed';
    await payment.save();

    return res.json(
      new ApiResponse(200, payment, 'Payment failed - new payment method required')
    );
  }

  // For other statuses, update accordingly
  payment.status = paymentIntent.status === 'canceled' ? 'cancelled' : 'processing';
  await payment.save();

  res.json(
    new ApiResponse(200, payment, `Payment status: ${paymentIntent.status}`)
  );
});

/**
 * Cancel a pending payment
 */
const cancelPayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId });

  if (!payment) {
    throw new ApiError(404, 'Payment not found');
  }

  if (payment.status === 'succeeded') {
    throw new ApiError(400, 'Cannot cancel a completed payment. Use refund instead.');
  }

  // Cancel Stripe PaymentIntent if exists
  if (payment.stripePaymentIntentId) {
    try {
      await stripe.paymentIntents.cancel(payment.stripePaymentIntentId);
    } catch {
      // May already be cancelled, continue
    }
  }

  payment.status = 'cancelled';
  await payment.save();

  res.json(new ApiResponse(200, payment, 'Payment cancelled successfully'));
});

/**
 * Refund a completed payment
 */
const refundPayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;
  const { amount } = req.body; // Optional partial refund amount

  const payment = await Payment.findOne({ _id: id, organizationId: orgId });

  if (!payment) {
    throw new ApiError(404, 'Payment not found');
  }

  if (payment.status !== 'succeeded') {
    throw new ApiError(400, 'Can only refund completed payments');
  }

  if (!payment.stripePaymentIntentId) {
    throw new ApiError(400, 'No Stripe payment intent found for this payment');
  }

  const refundParams: Stripe.RefundCreateParams = {
    payment_intent: payment.stripePaymentIntentId,
  };

  if (amount) {
    refundParams.amount = Math.round(amount * 100);
  }

  await stripe.refunds.create(refundParams);

  payment.status = 'refunded';
  await payment.save();

  res.json(new ApiResponse(200, payment, 'Payment refunded successfully'));
});

/**
 * Update payment fields (status, notes, dueDate, etc.)
 */
const updatePayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;
  const { status, notes, dueDate } = req.body;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId });

  if (!payment) {
    throw new ApiError(404, 'Payment not found');
  }

  const validStatuses = ['pending', 'processing', 'succeeded', 'failed', 'refunded', 'cancelled'];
  if (status !== undefined) {
    if (!validStatuses.includes(status)) {
      throw new ApiError(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    }
    payment.status = status;
    if (status === 'succeeded' && !payment.paidAt) {
      payment.paidAt = new Date();
    }
  }

  if (notes !== undefined) payment.notes = notes;
  if (dueDate !== undefined) payment.dueDate = dueDate ? new Date(dueDate) : undefined;

  await payment.save();

  res.json(new ApiResponse(200, payment, 'Payment updated successfully'));
});

/**
 * Get payment statistics
 */
const getPaymentStats = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const stats = await Payment.aggregate([
    { $match: { organizationId: orgId } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
      },
    },
  ]);

  const formatted: Record<string, { count: number; totalAmount: number }> = {
    pending: { count: 0, totalAmount: 0 },
    processing: { count: 0, totalAmount: 0 },
    succeeded: { count: 0, totalAmount: 0 },
    failed: { count: 0, totalAmount: 0 },
    refunded: { count: 0, totalAmount: 0 },
    cancelled: { count: 0, totalAmount: 0 },
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

  res.json(
    new ApiResponse(200, {
      byStatus: formatted,
      totalCount,
      totalRevenue,
      pendingAmount: formatted.pending.totalAmount + formatted.failed.totalAmount,
    }, 'Payment statistics fetched successfully')
  );
});

/**
 * Stripe webhook handler (for async payment events)
 */
const handleStripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string;

  if (!sig) {
    throw new ApiError(400, 'Missing Stripe signature');
  }

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      (req as any).rawBody,
      sig,
      config.stripe.webhookSecret
    );
  } catch (err: any) {
    throw new ApiError(400, `Webhook signature verification failed: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const payment = await Payment.findOne({ stripePaymentIntentId: pi.id });
      if (payment && payment.status !== 'succeeded') {
        payment.status = 'succeeded';
        payment.paidAt = new Date();
        payment.stripeChargeId = pi.latest_charge as string;
        await payment.save();
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const payment = await Payment.findOne({ stripePaymentIntentId: pi.id });
      if (payment) {
        payment.status = 'failed';
        payment.failureReason = pi.last_payment_error?.message || 'Payment failed';
        await payment.save();
      }
      break;
    }

    default:
      break;
  }

  res.json({ received: true });
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
  handleStripeWebhook,
};