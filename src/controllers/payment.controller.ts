import { Request, Response } from 'express';
import Stripe from 'stripe';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { safeCreateNotification, notifyOrgAdmins } from '../utils/safeNotification';
import Payment, { IPaymentLineItem } from '../models/Payment.model';
import User, { IUser } from '../models/User.model';
import AftermarketInquiry from '../models/AftermarketInquiry.model';
import config from '../config';
import ReferralService from '../services/referral.service';
import membershipService from '../services/membership.service';
import logger from '../utils/logger';
import activityService from '../services/activity.service';
import { getSocketIO, emitToUser } from '../utils/socketEmitter';
import { getIO } from '../socket/supraspace.socket';

const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2026-01-28.clover',
});

// Base URL the customer portal is served from — used for Stripe Checkout redirects.
const CUSTOMER_APP_URL =
  process.env.CUSTOMER_APP_URL ||
  process.env.CLIENT_URL ||
  process.env.FRONTEND_URL ||
  'http://localhost:3000';

const getUserId = (req: Request): string => {
  const userId = (req.user as IUser)?._id?.toString();
  if (!userId) throw new ApiError(401, 'User not authenticated');
  return userId;
};

// ─── Shared success side-effects (sockets + aftermarket sync + loyalty) ───────
//
// Called once a payment flips to "succeeded" via any path (Checkout webhook,
// PaymentIntent webhook, or manual/customer confirm). Best-effort & idempotent.
async function broadcastPaymentSuccess(payment: any) {
  // 1) CRM dashboards (org room on the main socket)
  try {
    const io = getSocketIO();
    if (io && payment.organizationId) {
      io.to(`org:${payment.organizationId}`).emit('payment:updated', {
        paymentId: payment._id.toString(),
        status: 'succeeded',
        amount: payment.amount,
        source: payment.source || 'manual',
      });
    }
  } catch (e) {
    logger.warn({ err: e }, '[Payment] org socket emit failed');
  }

  // 2) The paying customer (main socket, resolved by email → User)
  try {
    if (payment.customerEmail) {
      const u = await User.findOne({ email: payment.customerEmail.toLowerCase() }).select('_id');
      if (u) {
        emitToUser(u._id.toString(), 'payment:updated', {
          paymentId: payment._id.toString(),
          status: 'succeeded',
        });
      }
    }
  } catch (e) {
    logger.warn({ err: e }, '[Payment] customer socket emit failed');
  }

  // 3) Aftermarket-specific sync: close the inquiry, ping the CRM support room,
  //    and award loyalty points just like a fulfilled aftermarket order.
  if (payment.source === 'aftermarket') {
    try {
      getIO().to('crm:staff').emit('aftermarket:invoice_paid', {
        paymentId: payment._id.toString(),
        inquiryId: payment.inquiryId ? payment.inquiryId.toString() : null,
        productId: payment.aftermarketProductId ? payment.aftermarketProductId.toString() : null,
      });
    } catch { /* SupraSpace socket optional */ }

    if (payment.inquiryId) {
      try {
        await AftermarketInquiry.findByIdAndUpdate(payment.inquiryId, { status: 'closed' });
      } catch (e) {
        logger.warn({ err: e, inquiryId: payment.inquiryId }, '[Payment] inquiry close failed');
      }
    }

    try {
      const u = await User.findOne({ email: payment.customerEmail.toLowerCase() }).select('_id');
      if (u) {
        membershipService
          .creditPoints({
            userId: u._id.toString(),
            organizationId: payment.organizationId.toString(),
            delta: Math.max(1, Math.floor(payment.amount)),
            sourceType: 'aftermarket_order' as any,
            sourceId: payment._id.toString(),
            description: `Aftermarket invoice paid: $${payment.amount.toFixed(2)}`,
            metadata: { paymentId: payment._id.toString(), invoiceNumber: payment.invoiceNumber },
          })
          .catch(() => {});
      }
    } catch { /* loyalty is best-effort */ }
  }
}

// ─── Line-item totals helper ──────────────────────────────────────────────────
function computeTotals(
  lineItems: IPaymentLineItem[],
  taxRate = 0
): { normalized: IPaymentLineItem[]; subtotal: number; taxAmount: number; total: number } {
  const normalized = lineItems.map((li) => {
    const quantity = Math.max(0, Number(li.quantity) || 0);
    const unitPrice = Number(li.unitPrice) || 0;
    const raw = quantity * unitPrice;
    const lineTotal = li.kind === 'discount' ? -Math.abs(raw) : raw;
    return {
      label: String(li.label || '').trim() || 'Item',
      kind: (li.kind || 'product') as IPaymentLineItem['kind'],
      quantity,
      unitPrice,
      lineTotal: Math.round(lineTotal * 100) / 100,
    };
  });

  const subtotal = Math.round(normalized.reduce((s, li) => s + li.lineTotal, 0) * 100) / 100;
  const taxAmount = Math.round(Math.max(0, subtotal) * (Number(taxRate) || 0)) / 100;
  const total = Math.round((subtotal + taxAmount) * 100) / 100;
  return { normalized, subtotal, taxAmount, total };
}

// ─── Create Payment ───────────────────────────────────────────────────────────
const createPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const {
    customerName, customerEmail, customerPhone,
    amount, currency = 'usd', description,
    quoteId, shipmentId, dueDate, notes,
    lineItems, taxRate,
  } = req.body;

  if (!customerName || !customerEmail || !description) {
    throw new ApiError(400, 'customerName, customerEmail, and description are required');
  }

  // If line items were supplied, derive the total from them; otherwise use `amount`.
  let payload: any = { taxRate: Number(taxRate) || 0 };
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    const { normalized, subtotal, taxAmount, total } = computeTotals(lineItems, Number(taxRate) || 0);
    if (total <= 0) throw new ApiError(400, 'Invoice total must be greater than zero');
    payload = { lineItems: normalized, subtotal, taxAmount, taxRate: Number(taxRate) || 0, amount: total };
  } else {
    if (!amount || amount <= 0) throw new ApiError(400, 'Amount must be greater than zero');
    payload.amount = amount;
  }

  const payment = await Payment.create({
    organizationId: orgId,
    customerId: customerEmail,
    customerName,
    customerEmail: customerEmail.toLowerCase(),
    customerPhone,
    currency,
    description,
    status: 'pending',
    quoteId,
    shipmentId,
    dueDate: dueDate ? new Date(dueDate) : undefined,
    notes,
    createdBy: userId,
    ...payload,
  });

  notifyOrgAdmins(
    orgId, 'payment_pending', 'New Payment Created',
    `A payment of $${payment.amount.toFixed(2)} for ${customerName} is pending.`,
    { paymentId: payment._id.toString(), amount: payment.amount, customerName }
  );

  logger.info({ paymentId: payment._id, amount: payment.amount, customerEmail }, 'Payment record created');

  res.status(201).json(new ApiResponse(201, payment, 'Payment record created successfully'));
});

// ─── Get Payments ─────────────────────────────────────────────────────────────
const getPayments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const {
    status, search, limit = '50', skip = '0',
    minAmount, maxAmount, fromDate, toDate, paymentMethod, source,
  } = req.query;

  const filter: Record<string, unknown> = { organizationId: orgId };
  if (status && status !== 'all') filter.status = status;
  if (source && source !== 'all') filter.source = source;

  if (search) {
    const regex = new RegExp(search as string, 'i');
    filter.$or = [
      { customerName: regex },
      { customerEmail: regex },
      { invoiceNumber: regex },
      { description: regex },
    ];
  }

  if (minAmount || maxAmount) {
    filter.amount = {} as Record<string, number>;
    if (minAmount !== undefined && minAmount !== '') (filter.amount as Record<string, number>).$gte = Number(minAmount);
    if (maxAmount !== undefined && maxAmount !== '') (filter.amount as Record<string, number>).$lte = Number(maxAmount);
  }

  if (fromDate || toDate) {
    filter.createdAt = {} as Record<string, Date>;
    if (fromDate) (filter.createdAt as Record<string, Date>).$gte = new Date(fromDate as string);
    if (toDate) {
      const endDate = new Date(toDate as string);
      endDate.setHours(23, 59, 59, 999);
      (filter.createdAt as Record<string, Date>).$lte = endDate;
    }
  }

  if (paymentMethod) filter.paymentMethod = new RegExp(paymentMethod as string, 'i');

  const [payments, total] = await Promise.all([
    Payment.find(filter)
      .populate('quoteId', 'firstName lastName vehicleName')
      .populate('shipmentId', 'trackingNumber')
      .populate('createdBy', 'name email')
      .populate('aftermarketProductId', 'name media')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit as string))
      .skip(parseInt(skip as string))
      .lean(),
    Payment.countDocuments(filter),
  ]);

  res.json(
    new ApiResponse(200, {
      payments, total,
      page: Math.floor(parseInt(skip as string) / Math.max(parseInt(limit as string) || 1, 1)) + 1,
      limit: parseInt(limit as string),
    }, 'Payments fetched successfully'),
  );
});

// ─── Get Pending Payments ─────────────────────────────────────────────────────
const getPendingPayments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const payments = await Payment.find({ organizationId: orgId, status: { $in: ['pending', 'failed'] } })
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
    .populate('createdBy', 'name email')
    .populate('aftermarketProductId', 'name media description');
  if (!payment) throw new ApiError(404, 'Payment not found');
  res.json(new ApiResponse(200, payment, 'Payment fetched successfully'));
});

// ─── Create Payment Intent (dealer-side, existing Elements flow kept) ─────────
const createPaymentIntent = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { paymentId } = req.body;
  if (!paymentId) throw new ApiError(400, 'paymentId is required');

  const payment = await Payment.findOne({ _id: paymentId, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status === 'succeeded') throw new ApiError(400, 'This payment has already been completed');
  if (payment.status === 'cancelled') throw new ApiError(400, 'This payment has been cancelled');

  if (payment.stripePaymentIntentId) {
    try {
      const existing = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      if (existing.status !== 'canceled' && existing.status !== 'succeeded') {
        return res.json(new ApiResponse(200, { clientSecret: existing.client_secret, paymentIntentId: existing.id }, 'Existing payment intent retrieved'));
      }
    } catch { /* expired — create new */ }
  }

  let stripeCustomerId = payment.stripeCustomerId;
  if (!stripeCustomerId) {
    const customers = await stripe.customers.list({ email: payment.customerEmail, limit: 1 });
    stripeCustomerId = customers.data.length > 0
      ? customers.data[0].id
      : (await stripe.customers.create({ name: payment.customerName, email: payment.customerEmail, phone: payment.customerPhone, metadata: { organizationId: orgId } })).id;
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(payment.amount * 100),
    currency: payment.currency,
    customer: stripeCustomerId,
    description: payment.description,
    metadata: { paymentId: payment._id.toString(), organizationId: orgId, invoiceNumber: payment.invoiceNumber || '' },
    automatic_payment_methods: { enabled: true },
  });

  await Payment.findByIdAndUpdate(payment._id, { stripePaymentIntentId: paymentIntent.id, stripeCustomerId, status: 'processing' });

  res.json(new ApiResponse(200, { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id }, 'Payment intent created successfully'));
});

// ─── Build a hosted Stripe Checkout Session for an invoice ────────────────────
// Charges exactly `payment.amount` as a single Checkout line so the total always
// matches the invoice (the itemised breakdown lives in our own UI). Used by both
// the customer "Pay Now" button and "Buy Now".
async function buildCheckoutSession(payment: any): Promise<Stripe.Checkout.Session> {
  let stripeCustomerId = payment.stripeCustomerId;
  if (!stripeCustomerId) {
    const customers = await stripe.customers.list({ email: payment.customerEmail, limit: 1 });
    stripeCustomerId = customers.data.length > 0
      ? customers.data[0].id
      : (await stripe.customers.create({
          name: payment.customerName,
          email: payment.customerEmail,
          phone: payment.customerPhone,
          metadata: { organizationId: payment.organizationId },
        })).id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer: stripeCustomerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: payment.currency || 'usd',
          unit_amount: Math.round(payment.amount * 100),
          product_data: {
            name: payment.invoiceNumber ? `Invoice ${payment.invoiceNumber}` : payment.description,
            description: payment.description?.slice(0, 300),
          },
        },
      },
    ],
    payment_intent_data: {
      description: payment.description,
      metadata: { paymentId: payment._id.toString(), organizationId: payment.organizationId },
    },
    metadata: {
      paymentId: payment._id.toString(),
      organizationId: payment.organizationId,
      invoiceNumber: payment.invoiceNumber || '',
      source: payment.source || 'manual',
    },
    success_url: `${CUSTOMER_APP_URL}/customer/payments?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${CUSTOMER_APP_URL}/customer/payments?status=cancelled`,
  });

  await Payment.findByIdAndUpdate(payment._id, {
    stripeCheckoutSessionId: session.id,
    stripeCustomerId,
    status: 'processing',
  });

  return session;
}

// ─── Customer: Create Checkout Session (hosted Stripe Checkout) ───────────────
const createCustomerCheckoutSession = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const { paymentId } = req.body;
  if (!paymentId) throw new ApiError(400, 'paymentId is required');

  const payment = await Payment.findById(paymentId);
  if (!payment) throw new ApiError(404, 'Invoice not found');
  if (payment.customerEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError(403, 'You are not authorized to pay this invoice');
  }
  if (payment.status === 'succeeded') throw new ApiError(400, 'This invoice has already been paid');
  if (payment.status === 'cancelled') throw new ApiError(400, 'This invoice has been cancelled');

  const session = await buildCheckoutSession(payment);
  res.json(new ApiResponse(200, { url: session.url, sessionId: session.id }, 'Checkout session created'));
});

// ─── Customer: poll a checkout session after returning from Stripe ────────────
const getCheckoutSessionStatus = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const { sessionId } = req.params;
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const paymentId = session.metadata?.paymentId;

  const payment = paymentId
    ? await Payment.findById(paymentId)
    : await Payment.findOne({ stripeCheckoutSessionId: sessionId });
  if (!payment) throw new ApiError(404, 'Invoice not found');
  if (payment.customerEmail.toLowerCase() !== user.email.toLowerCase()) throw new ApiError(403, 'Not authorized');

  // If the webhook hasn't landed yet but Stripe says paid, reconcile now.
  if (session.payment_status === 'paid' && payment.status !== 'succeeded') {
    payment.status = 'succeeded';
    payment.paidAt = new Date();
    payment.stripePaymentIntentId = (session.payment_intent as string) || payment.stripePaymentIntentId;
    payment.stripeCheckoutSessionId = session.id;
    await payment.save();
    try { await ReferralService.processPaymentReward(payment, user._id.toString()); } catch { /* noop */ }
    await broadcastPaymentSuccess(payment);
  }

  res.json(new ApiResponse(200, { status: payment.status, payment }, 'Checkout status'));
});

// ─── Confirm Payment (dealer, existing Elements path) ─────────────────────────
const confirmPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const { paymentIntentId } = req.body;
  if (!paymentIntentId) throw new ApiError(400, 'paymentIntentId is required');

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment record not found');

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
      userId, organizationId: orgId, type: 'payment_received', title: 'Payment Received',
      message: `Payment of $${payment.amount.toFixed(2)} from ${payment.customerName} was successful.`,
      metadata: { paymentId: payment._id.toString(), amount: payment.amount, customerName: payment.customerName },
    });

    await activityService.logFinancialActivity(
      userId, orgId, 'payment_completed', payment.amount,
      `Payment of $${payment.amount.toFixed(2)} confirmed from ${payment.customerName}`,
      { paymentId: payment._id.toString(), stripeChargeId: payment.stripeChargeId }
    );

    try { await ReferralService.processPaymentReward(payment, userId); } catch { /* noop */ }
    await broadcastPaymentSuccess(payment);

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
    { paymentId: payment._id.toString() });

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
    { paymentId: payment._id.toString() });

  await activityService.createActivity({
    userId: (req.user?._id as any).toString(),
    organizationId: orgId, type: 'wallet_adjustment', title: 'Payment Refunded',
    description: `Refund of $${(amount || payment.amount).toFixed(2)} processed for ${payment.customerName}`,
    metadata: { paymentId: payment._id.toString(), refundAmount: amount || payment.amount },
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
    if (!validStatuses.includes(status)) throw new ApiError(400, `Invalid status. Must be one of: ${validStatuses.join(', ')}`);
    payment.status = status;
    if (status === 'succeeded' && !payment.paidAt) payment.paidAt = new Date();
  }
  if (notes !== undefined) payment.notes = notes;
  if (dueDate !== undefined) payment.dueDate = dueDate ? new Date(dueDate) : undefined;

  await payment.save();

  if (previousStatus !== 'succeeded' && payment.status === 'succeeded') {
    try {
      const performingUserId = (req.user as IUser)?._id?.toString();
      await ReferralService.processPaymentReward(payment, performingUserId || 'MANUAL');
    } catch (e) { logger.error({ err: e }, '[Referral] updatePayment'); }
    await broadcastPaymentSuccess(payment);
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
    byStatus: formatted, totalCount, totalRevenue,
    pendingAmount: formatted.pending.totalAmount + formatted.failed.totalAmount,
  }, 'Payment statistics fetched successfully'));
});

// ─── Billing Balance ──────────────────────────────────────────────────────────
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
    // Hosted Checkout completion — primary path for aftermarket invoices & Buy Now.
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const paymentId = session.metadata?.paymentId;
      const payment = paymentId
        ? await Payment.findById(paymentId)
        : await Payment.findOne({ stripeCheckoutSessionId: session.id });

      if (payment && payment.status !== 'succeeded' && session.payment_status === 'paid') {
        payment.status = 'succeeded';
        payment.paidAt = new Date();
        payment.stripeCheckoutSessionId = session.id;
        payment.stripePaymentIntentId = (session.payment_intent as string) || payment.stripePaymentIntentId;

        if (payment.stripePaymentIntentId) {
          try {
            const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
            payment.stripeChargeId = (pi.latest_charge as string) || payment.stripeChargeId;
            if (payment.stripeChargeId) {
              const charge = await stripe.charges.retrieve(payment.stripeChargeId);
              payment.receiptUrl = charge.receipt_url || undefined;
              payment.paymentMethod = charge.payment_method_details?.type || undefined;
            }
          } catch { /* receipt is non-critical */ }
        }

        await payment.save();

        await safeCreateNotification({
          userId: payment.createdBy as any,
          organizationId: payment.organizationId,
          type: 'payment_received',
          title: 'Payment Received',
          message: `Payment of $${payment.amount.toFixed(2)} from ${payment.customerName} was successful.`,
          metadata: { paymentId: payment._id.toString(), amount: payment.amount, customerName: payment.customerName },
        });

        try { await ReferralService.processPaymentReward(payment, 'STRIPE_CHECKOUT'); }
        catch (e) { logger.error({ err: e, paymentId: payment._id }, 'Referral failed during checkout webhook'); }

        await activityService.createActivity({
          userId: 'SYSTEM',
          organizationId: payment.organizationId.toString(),
          type: 'payment_completed',
          title: 'Payment Succeeded (Checkout)',
          description: `Checkout confirmation: $${payment.amount.toFixed(2)} received`,
          metadata: { paymentId: payment._id.toString(), sessionId: session.id },
        }).catch(() => {});

        await broadcastPaymentSuccess(payment);
        logger.info({ paymentId: payment._id, sessionId: session.id }, 'Stripe Checkout: payment success');
      }
      break;
    }

    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const payment = await Payment.findOne({ stripePaymentIntentId: pi.id });
      if (payment && payment.status !== 'succeeded') {
        payment.status = 'succeeded';
        payment.paidAt = new Date();
        payment.stripeChargeId = pi.latest_charge as string;
        await payment.save();

        await activityService.createActivity({
          userId: 'SYSTEM', organizationId: payment.organizationId.toString(),
          type: 'payment_completed', title: 'Payment Succeeded (Webhook)',
          description: `Webhook confirmation: $${payment.amount.toFixed(2)} received`,
          metadata: { paymentId: payment._id.toString(), piId: pi.id },
        });

        logger.info({ paymentId: payment._id, piId: pi.id }, 'Stripe Webhook: Payment success');

        try { await ReferralService.processPaymentReward(payment, 'STRIPE_WEBHOOK'); }
        catch (e) { logger.error({ err: e, paymentId: payment._id }, 'Referral processing failed during webhook'); }

        await broadcastPaymentSuccess(payment);
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
        await Payment.findOneAndUpdate({ stripePaymentIntentId: charge.payment_intent }, { status: 'refunded' });
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
  if (!customer) throw new ApiError(404, 'Customer has not registered an account yet. Ask them to sign up first.');

  const dealer = req.user as IUser;
  const dealerName = dealer?.name || 'the dealer';

  await safeCreateNotification({
    userId: customer._id as any, organizationId: orgId, type: 'payment_request', title: 'Payment Request',
    message: `You have a pending payment of $${payment.amount.toFixed(2)} for "${payment.description}" from ${dealerName}. Please log in to complete your payment.`,
    metadata: { paymentId: payment._id.toString(), amount: payment.amount, description: payment.description, invoiceNumber: payment.invoiceNumber, route: '/customer/payments' },
  });

  res.json(new ApiResponse(200, null, 'Payment request sent to customer successfully'));
});

// ─── Customer: My Payments ────────────────────────────────────────────────────
const getMyPaymentsAsCustomer = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const payments = await Payment.find({ customerEmail: user.email.toLowerCase() })
    .populate('aftermarketProductId', 'name media')
    .sort({ createdAt: -1 })
    .lean();

  const totalOwed = payments.filter(p => p.status === 'pending' || p.status === 'failed').reduce((s, p) => s + p.amount, 0);
  const totalPaid = payments.filter(p => p.status === 'succeeded').reduce((s, p) => s + p.amount, 0);
  const pendingCount = payments.filter(p => p.status === 'pending' || p.status === 'failed').length;

  res.json(new ApiResponse(200, { payments, stats: { totalOwed, totalPaid, pendingCount } }, 'Payments fetched successfully'));
});

// ─── Customer: Create Payment Intent (legacy Elements path, kept) ─────────────
const createCustomerPaymentIntent = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const { paymentId } = req.body;
  if (!paymentId) throw new ApiError(400, 'paymentId is required');

  const payment = await Payment.findById(paymentId);
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.customerEmail.toLowerCase() !== user.email.toLowerCase()) throw new ApiError(403, 'You are not authorized to pay this invoice');
  if (payment.status === 'succeeded') throw new ApiError(400, 'This payment has already been completed');
  if (payment.status === 'cancelled') throw new ApiError(400, 'This payment has been cancelled');

  if (payment.stripePaymentIntentId) {
    try {
      const existing = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      if (existing.status !== 'canceled' && existing.status !== 'succeeded') {
        return res.json(new ApiResponse(200, { clientSecret: existing.client_secret, paymentIntentId: existing.id }, 'Existing payment intent retrieved'));
      }
    } catch { /* create new */ }
  }

  let stripeCustomerId = payment.stripeCustomerId;
  if (!stripeCustomerId) {
    const customers = await stripe.customers.list({ email: payment.customerEmail, limit: 1 });
    stripeCustomerId = customers.data.length > 0
      ? customers.data[0].id
      : (await stripe.customers.create({ name: payment.customerName, email: payment.customerEmail, phone: payment.customerPhone })).id;
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(payment.amount * 100),
    currency: payment.currency,
    customer: stripeCustomerId,
    description: payment.description,
    metadata: { paymentId: payment._id.toString(), invoiceNumber: payment.invoiceNumber || '' },
    automatic_payment_methods: { enabled: true },
  });

  await Payment.findByIdAndUpdate(payment._id, { stripePaymentIntentId: paymentIntent.id, stripeCustomerId, status: 'processing' });

  res.json(new ApiResponse(200, { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id }, 'Payment intent created successfully'));
});

// ─── Customer: Confirm Payment (legacy Elements path, kept) ───────────────────
const confirmCustomerPayment = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const { paymentIntentId } = req.body;
  if (!paymentIntentId) throw new ApiError(400, 'paymentIntentId is required');

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId });
  if (!payment) throw new ApiError(404, 'Payment record not found');
  if (payment.customerEmail.toLowerCase() !== user.email.toLowerCase()) throw new ApiError(403, 'Not authorized');

  if (payment.status === 'succeeded') return res.json(new ApiResponse(200, payment, 'Payment already confirmed'));

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

    try { await ReferralService.processPaymentReward(payment, user._id.toString()); }
    catch (e) { logger.error({ err: e, paymentId: payment._id }, 'Referral processing failed during customer confirmation'); }

    await activityService.logFinancialActivity(
      user._id.toString(), payment.organizationId?.toString(), 'payment_completed', payment.amount,
      `Customer payment of $${payment.amount.toFixed(2)} confirmed`,
      { paymentId: payment._id.toString(), stripeChargeId: payment.stripeChargeId }
    );

    await safeCreateNotification({
      userId: payment.createdBy as any, organizationId: payment.organizationId, type: 'payment_received', title: 'Payment Received',
      message: `Payment of $${payment.amount.toFixed(2)} from ${payment.customerName} was successful.`,
      metadata: { paymentId: payment._id.toString(), amount: payment.amount, customerName: payment.customerName },
    });

    await broadcastPaymentSuccess(payment);
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
  // NEW — hosted Stripe Checkout
  createCustomerCheckoutSession,
  getCheckoutSessionStatus,
};