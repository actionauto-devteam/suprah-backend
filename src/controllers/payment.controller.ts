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
import {
  refundRequestFor,
  refundStateFromCharge,
  refundUpdate,
  remainingRefundable,
  roundCents,
} from '../utils/paymentRefund';
import { CUSTOMER_INVOICE_FIELDS, customerInvoiceView, isAwaitingPayment } from '../utils/customerPayments';
import { claimFailed, claimPaid } from '../utils/paymentPaid';
import {
  KEPT_AMOUNT,
  StripeDisputeLike,
  disputeNotice,
  disputeOutcome,
  disputeUpdate,
  keptAmount,
} from '../utils/paymentDispute';
import { fillMonthlyRevenue, lastMonths } from '../utils/paymentTrend';
import { cleanSearchText, escapeSearchRegex } from '../utils/searchText';
import mongoose from 'mongoose';
import { invoiceLinesFrom, taxRateFrom } from '../utils/invoiceLines';
import { paymentPurposeFrom } from '../utils/paymentPurpose';
import { dealershipForPayments, getPlatformSettings, paymentLimitProblem } from '../services/suprahPaySettings.service';
import Organization from '../models/Organization.model';
import { statementSuffixFor } from '../utils/paymentBranding';
import { cardFailureReason, refundProblemMessage, stripeErrorForLog } from '../utils/stripeErrors';

const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2026-02-25.clover',
});

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

/** Charge, receipt and card type for a paid PaymentIntent (the receipt is non-critical). */
async function paidDetailsFromIntent(pi: Stripe.PaymentIntent): Promise<Record<string, unknown>> {
  const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
  if (!chargeId) return {};
  const details: Record<string, unknown> = { stripeChargeId: chargeId };
  try {
    const charge = await stripe.charges.retrieve(chargeId);
    details.receiptUrl = charge.receipt_url || undefined;
    details.paymentMethod = charge.payment_method_details?.type || undefined;
  } catch { /* non-critical */ }
  return details;
}

/**
 * Everything that follows a payment going through: tell the staff member who
 * sent the invoice, give a referral reward if one is due, record it, and
 * update open screens. Called only by whichever path marked it paid first
 * (Stripe's update, or the customer coming back), so it runs once.
 */
async function afterPaid(payment: any, source: string) {
  await safeCreateNotification({
    userId: payment.createdBy as any,
    organizationId: payment.organizationId,
    type: 'payment_received',
    title: 'Payment Received',
    message: `Payment of $${payment.amount.toFixed(2)} from ${payment.customerName} was successful.`,
    metadata: { paymentId: payment._id.toString(), amount: payment.amount, customerName: payment.customerName },
  });

  try { await ReferralService.processPaymentReward(payment, source); }
  catch (e) { logger.error({ err: e, paymentId: payment._id }, 'Referral reward failed after payment'); }

  await activityService.createActivity({
    userId: 'SYSTEM',
    organizationId: payment.organizationId.toString(),
    type: 'payment_completed',
    title: 'Payment Succeeded',
    description: `Payment of $${payment.amount.toFixed(2)} received`,
    metadata: { paymentId: payment._id.toString(), source },
  }).catch(() => {});

  await broadcastPaymentSuccess(payment);
}

/**
 * Records a card dispute on its invoice and tells the dealership's admins
 * when something changed (opened, won or lost). The same news arriving twice
 * tells nobody twice.
 */
async function recordDispute(dispute: Stripe.Dispute) {
  const piId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
  const match = [
    ...(piId ? [{ stripePaymentIntentId: piId }] : []),
    ...(chargeId ? [{ stripeChargeId: chargeId }] : []),
  ];
  if (!match.length) return;

  const details: StripeDisputeLike = { id: dispute.id, status: dispute.status, amount: dispute.amount, reason: dispute.reason };
  // Returns the invoice as it was before this update, to tell what changed.
  const before = await Payment.findOneAndUpdate({ $or: match }, disputeUpdate(details, new Date()), { new: false });
  if (!before) {
    logger.warn({ disputeId: dispute.id }, 'Stripe dispute for a payment Suprah does not know');
    return;
  }

  const outcome = disputeOutcome(dispute.status);
  if (before.disputeStatus === outcome && before.stripeDisputeId === dispute.id) return;

  const notice = disputeNotice(before, outcome, details.amount / 100);
  try {
    await notifyOrgAdmins(before.organizationId.toString(), 'payment_failed', notice.title, notice.message, {
      paymentId: before._id.toString(),
      disputeStatus: outcome,
      route: '/billing/payments',
    });
  } catch { /* the dispute is recorded even if the notice fails */ }
  logger.info({ paymentId: before._id, disputeId: dispute.id, outcome }, 'Stripe dispute recorded');
}

async function broadcastPaymentSuccess(payment: any) {
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

// ─── Create Payment ───────────────────────────────────────────────────────────
// A payment request from the dealership's staff (Leads → Request Payment).
// Everything is checked before anything is saved (2026-11-21): SuprahPay must
// be on for the dealership, the amount within SuprahPay's limit, US dollars
// only, and lines, tax and dates real values. Suprah's fee rate at this moment
// is recorded on the invoice for the dealership's payout.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const textOf = (value: unknown, max: number): string | null => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > max ? null : text;
};
const twoDecimals = (n: number) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

const createPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  const customerName = textOf(body.customerName, 200);
  const customerEmail = textOf(body.customerEmail, 254)?.toLowerCase() ?? null;
  const description = textOf(body.description, 500);
  const customerPhone = textOf(body.customerPhone, 40);
  const notes = textOf(body.notes, 2000);
  if (customerName === null || customerEmail === null || description === null || customerPhone === null || notes === null) {
    throw new ApiError(400, "One of the details is too long or isn't text. Please check the form.");
  }
  if (!customerName || !customerEmail || !description) {
    throw new ApiError(400, "Enter the customer's name and email, and a description of the payment.");
  }
  if (!EMAIL_PATTERN.test(customerEmail)) throw new ApiError(400, "Enter the customer's email address, for example name@example.com.");

  const currency = body.currency === undefined ? 'usd' : String(body.currency).trim().toLowerCase();
  if (currency !== 'usd') throw new ApiError(400, 'SuprahPay takes payments in US dollars only.');

  const purpose = paymentPurposeFrom(body.purpose);
  if (!purpose) throw new ApiError(400, 'Choose what the payment is for.');

  for (const [field, label] of [['quoteId', 'quote'], ['shipmentId', 'shipment']] as const) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== '' && !mongoose.isValidObjectId(body[field])) {
      throw new ApiError(400, `That ${label} couldn't be found.`);
    }
  }
  let dueDate: Date | undefined;
  if (body.dueDate) {
    dueDate = new Date(String(body.dueDate));
    if (Number.isNaN(dueDate.getTime())) throw new ApiError(400, 'Enter a valid due date.');
  }

  // SuprahPay must be on for this dealership; also gives its tax rate and Suprah's settings.
  const dealership = await dealershipForPayments(orgId);

  let payload: Record<string, unknown>;
  if (Array.isArray(body.lineItems) && body.lineItems.length > 0) {
    // Invoice lines: the dealership's default tax rate applies unless one is given.
    const taxRate = body.taxRate === undefined || body.taxRate === '' ? dealership.defaultTaxRate : taxRateFrom(body.taxRate);
    if (taxRate === null) throw new ApiError(400, 'Enter a tax rate from 0% to 100%.');
    const checked = invoiceLinesFrom(body.lineItems);
    if (!checked.ok) throw new ApiError(400, checked.message);
    const taxAmount = Math.round(Math.max(0, checked.subtotal) * taxRate) / 100;
    payload = {
      lineItems: checked.lines,
      subtotal: checked.subtotal,
      taxAmount,
      taxRate,
      amount: roundCents(checked.subtotal + taxAmount),
    };
  } else {
    // One amount: what the customer pays, as typed (no tax is added to it).
    const amount = typeof body.amount === 'number' ? body.amount : Number(String(body.amount ?? '').trim() || NaN);
    if (!Number.isFinite(amount) || amount <= 0 || !twoDecimals(amount)) {
      throw new ApiError(400, 'Enter the amount in dollars and cents, for example 125.50.');
    }
    payload = { amount: roundCents(amount), taxRate: 0 };
  }
  const limitProblem = paymentLimitProblem(payload.amount as number, dealership.maxPaymentAmount);
  if (limitProblem) throw new ApiError(400, limitProblem);

  const payment = await Payment.create({
    organizationId: orgId,
    customerId: customerEmail,
    customerName,
    customerEmail,
    customerPhone: customerPhone || undefined,
    currency,
    description,
    purpose,
    suprahFeePercent: dealership.feePercent,
    status: 'pending',
    quoteId: body.quoteId || undefined,
    shipmentId: body.shipmentId || undefined,
    dueDate,
    notes: notes || undefined,
    createdBy: userId,
    ...payload,
  });

  notifyOrgAdmins(
    orgId, 'payment_pending', 'New Payment Created',
    `A payment of $${payment.amount.toFixed(2)} for ${customerName} is pending.`,
    { paymentId: payment._id.toString(), amount: payment.amount, customerName }
  );

  // No customer details in the server log.
  logger.info({ paymentId: payment._id, amount: payment.amount }, 'Payment record created');

  res.status(201).json(new ApiResponse(201, payment, 'Payment record created successfully'));
});

// ─── Get Payments ─────────────────────────────────────────────────────────────
const getPayments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const {
    status, search, skip = '0', minAmount, maxAmount,
    fromDate, toDate, paymentMethod, source,
  } = req.query;

  const isReportRequest = req.query.report === 'true';
  const requestedLimit = parseInt(req.query.limit as string) || (isReportRequest ? 5000 : 50);
  const limit = Math.min(isReportRequest ? 5000 : 200, Math.max(1, requestedLimit));
  const parsedSkip = Math.max(0, parseInt(skip as string) || 0);

  const filter: Record<string, any> = { organizationId: orgId };
  if (status && status !== 'all') filter.status = status;
  if (source && source !== 'all') filter.source = source;

  // Typed text is matched as plain text: characters like ( * + ? are searched
  // for, not run as a search pattern (2026-11-20).
  const searchText = cleanSearchText(search, 100);
  if (searchText) {
    const regex = new RegExp(escapeSearchRegex(searchText), 'i');
    filter.$or = [
      { customerName: regex },
      { customerEmail: regex },
      { invoiceNumber: regex },
      { description: regex },
    ];
  }

  if (minAmount || maxAmount) {
    filter.amount = {};
    if (minAmount !== undefined && minAmount !== '') filter.amount.$gte = Number(minAmount);
    if (maxAmount !== undefined && maxAmount !== '') filter.amount.$lte = Number(maxAmount);
  }

  // Existing date range remains supported. Reports may use month/year or date=YYYY-MM.
  const dateParam = (req.query.date as string | undefined)?.trim();
  const dateMatch = dateParam?.match(/^(\d{4})-(\d{2})$/);
  const reportYear = Number(req.query.year ?? dateMatch?.[1]);
  const reportMonth = Number(req.query.month ?? dateMatch?.[2]);

  if (Number.isInteger(reportYear) && Number.isInteger(reportMonth) && reportMonth >= 1 && reportMonth <= 12) {
    filter.createdAt = {
      $gte: new Date(Date.UTC(reportYear, reportMonth - 1, 1)),
      $lt: new Date(Date.UTC(reportYear, reportMonth, 1)),
    };
  } else if (fromDate || toDate) {
    filter.createdAt = {};
    if (fromDate) filter.createdAt.$gte = new Date(fromDate as string);
    if (toDate) {
      const endDate = new Date(toDate as string);
      endDate.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = endDate;
    }
  }

  const methodText = cleanSearchText(paymentMethod, 40);
  if (methodText) filter.paymentMethod = new RegExp(escapeSearchRegex(methodText), 'i');

  const [payments, total, summaryRows] = await Promise.all([
    Payment.find(filter)
      .populate('quoteId', 'firstName lastName vehicleName')
      .populate('loadId', 'loadNumber status pickupLocation deliveryLocation')
      .populate('createdBy', 'name email')
      .populate('aftermarketProductId', 'name media')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(parsedSkip)
      .lean(),
    Payment.countDocuments(filter),
    Payment.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalInvoices: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          // Partly refunded payments stay "succeeded"; count only the part kept
          // (and leave out a dispute the dealership lost).
          totalRevenue: {
            $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, KEPT_AMOUNT, 0] },
          },
          paidInvoices: { $sum: { $cond: [{ $eq: ['$status', 'succeeded'] }, 1, 0] } },
          pendingAmount: {
            $sum: {
              $cond: [{ $in: ['$status', ['pending', 'processing', 'failed']] }, '$amount', 0],
            },
          },
          refundedAmount: {
            $sum: {
              $switch: {
                branches: [
                  { case: { $eq: ['$status', 'refunded'] }, then: { $ifNull: ['$refundedAmount', '$amount'] } },
                  { case: { $eq: ['$status', 'succeeded'] }, then: { $ifNull: ['$refundedAmount', 0] } },
                ],
                default: 0,
              },
            },
          },
        },
      },
    ]),
  ]);

  const aggregate = summaryRows[0] ?? {};
  const totalInvoices = aggregate.totalInvoices ?? 0;
  const paidInvoices = aggregate.paidInvoices ?? 0;
  const summary = {
    totalInvoices,
    paidInvoices,
    totalAmount: aggregate.totalAmount ?? 0,
    totalRevenue: aggregate.totalRevenue ?? 0,
    pendingAmount: aggregate.pendingAmount ?? 0,
    refundedAmount: aggregate.refundedAmount ?? 0,
    averageInvoice: totalInvoices ? (aggregate.totalAmount ?? 0) / totalInvoices : 0,
    successRate: totalInvoices ? (paidInvoices / totalInvoices) * 100 : 0,
  };

  res.json(
    new ApiResponse(
      200,
      {
        payments,
        total,
        summary,
        page: Math.floor(parsedSkip / limit) + 1,
        limit,
      },
      'Payments fetched successfully',
    ),
  );
});

// ─── Get Pending Payments ─────────────────────────────────────────────────────
const getPendingPayments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const payments = await Payment.find({ organizationId: orgId, status: { $in: ['pending', 'failed'] } })
    .populate('quoteId', 'firstName lastName vehicleName')
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
    .populate('createdBy', 'name email')
    .populate('aftermarketProductId', 'name media description');
  if (!payment) throw new ApiError(404, 'Payment not found');
  res.json(new ApiResponse(200, payment, 'Payment fetched successfully'));
});

/**
 * Checks before any way of paying opens (2026-11-23): Stripe's payment page
 * and both card forms. A refunded invoice can't be paid again, and nothing
 * over SuprahPay's limit for one payment (it may have been lowered after the
 * invoice was sent).
 */
async function refuseRefundedOrOverLimit(payment: { status?: string; amount: number }, payer: 'customer' | 'staff') {
  if (payment.status === 'refunded') throw new ApiError(400, 'This invoice has been refunded');
  const { maxPaymentAmount } = await getPlatformSettings();
  if (payment.amount > maxPaymentAmount) {
    throw new ApiError(400, payer === 'customer'
      ? "This invoice is more than SuprahPay's limit for one online payment. Please contact the dealership."
      : "This invoice is more than SuprahPay's limit for one online payment, so it can't be paid by card here.");
  }
}

// ─── Create Payment Intent (dealer-side, existing Elements flow kept) ─────────
const createPaymentIntent = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { paymentId } = req.body;
  if (!paymentId) throw new ApiError(400, 'paymentId is required');

  const payment = await Payment.findOne({ _id: paymentId, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status === 'succeeded') throw new ApiError(400, 'This payment has already been completed');
  if (payment.status === 'cancelled') throw new ApiError(400, 'This payment has been cancelled');
  await refuseRefundedOrOverLimit(payment, 'staff');

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
    // Card only (2026-11-21); Apple Pay and Google Pay come with cards.
    payment_method_types: ['card'],
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

  // SuprahPay branding with the dealership's name (2026-11-21): the payment
  // page, Stripe's receipt and the card statement say which dealership it's for.
  const org = mongoose.isValidObjectId(payment.organizationId)
    ? await Organization.findById(payment.organizationId).select('name').lean()
    : null;
  const dealershipName = String(org?.name || '').trim();
  const description = String(payment.description || '').trim();
  const invoiceTitle = payment.invoiceNumber ? `Invoice ${payment.invoiceNumber}` : description || 'Invoice';
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    customer: stripeCustomerId,
    // Card only (2026-11-21); Apple Pay and Google Pay come with cards.
    payment_method_types: ['card'],
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: payment.currency || 'usd',
          unit_amount: Math.round(payment.amount * 100),
          product_data: {
            name: (dealershipName ? `${dealershipName} · ${invoiceTitle}` : invoiceTitle).slice(0, 250),
            ...(description ? { description: description.slice(0, 300) } : {}),
          },
        },
      },
    ],
    payment_intent_data: {
      description: (dealershipName ? `${dealershipName}: ${description || invoiceTitle}` : description || invoiceTitle).slice(0, 1000),
      metadata: { paymentId: payment._id.toString(), organizationId: payment.organizationId },
    },
    metadata: {
      paymentId: payment._id.toString(),
      organizationId: payment.organizationId,
      invoiceNumber: payment.invoiceNumber || '',
      source: payment.source || 'manual',
    },
    success_url: `${CUSTOMER_APP_URL}/customer/payments?status=success&session_id={CHECKOUT_SESSION_ID}`,
    // Coming back without paying puts this invoice back under "To pay".
    cancel_url: `${CUSTOMER_APP_URL}/customer/payments?status=cancelled&invoice=${payment._id.toString()}`,
  };
  const suffix = statementSuffixFor(dealershipName);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      suffix
        ? { ...sessionParams, payment_intent_data: { ...sessionParams.payment_intent_data, statement_descriptor_suffix: suffix } }
        : sessionParams,
    );
  } catch (error: any) {
    // The card statement wording is a nice-to-have: never let it stop a payment.
    if (!suffix || !/statement_descriptor/i.test(String(error?.param || error?.message || ''))) throw error;
    session = await stripe.checkout.sessions.create(sessionParams);
  }

  await Payment.findByIdAndUpdate(payment._id, {
    stripeCheckoutSessionId: session.id,
    stripeCustomerId,
    status: 'processing',
  });

  return session;
}

// ─── The invoice's earlier Stripe payment page ────────────────────────────────
/**
 * Before a new Stripe payment page opens, or when the customer comes back
 * without paying, check the invoice's earlier page with Stripe: if it was paid
 * the invoice is marked paid (once); if it's still open it is closed. So the
 * same invoice can never be paid twice. Returns what was found.
 */
async function settleEarlierCheckout(payment: any): Promise<'paid' | 'closed' | 'none'> {
  if (!payment.stripeCheckoutSessionId) return 'none';
  let session = await stripe.checkout.sessions.retrieve(payment.stripeCheckoutSessionId);
  if (session.status === 'open') {
    try {
      session = await stripe.checkout.sessions.expire(session.id);
    } catch {
      // It may have been paid at this very moment: look again.
      session = await stripe.checkout.sessions.retrieve(session.id);
    }
  }
  if (session.payment_status === 'paid') {
    const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    const claimed = await claimPaid(
      { _id: payment._id },
      { stripeCheckoutSessionId: session.id, ...(piId ? { stripePaymentIntentId: piId } : {}) },
    );
    if (claimed) await afterPaid(claimed, 'STRIPE_CHECKOUT_CHECK');
    return 'paid';
  }
  if (session.status === 'open') {
    throw new ApiError(409, 'Your earlier payment page is still open. Please try again in a moment.');
  }
  return 'closed';
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
  await refuseRefundedOrOverLimit(payment, 'customer');

  // A payment page was opened before: make sure it wasn't paid, and close it.
  if ((await settleEarlierCheckout(payment)) === 'paid') {
    throw new ApiError(409, 'This invoice was already paid. Refresh to see your receipt.');
  }

  const session = await buildCheckoutSession(payment);
  res.json(new ApiResponse(200, { url: session.url, sessionId: session.id }, 'Checkout session created'));
});

// ─── Customer: came back from Stripe's page without paying ────────────────────
const leaveCheckout = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const payment = await Payment.findById(req.params.id);
  if (!payment) throw new ApiError(404, 'Invoice not found');
  if (payment.customerEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError(403, 'You are not authorized to change this invoice');
  }
  if (payment.status !== 'processing' || !payment.stripeCheckoutSessionId) {
    return res.json(new ApiResponse(200, { status: payment.status }, 'Nothing to change'));
  }

  if ((await settleEarlierCheckout(payment)) === 'paid') {
    return res.json(new ApiResponse(200, { status: 'succeeded' }, 'This invoice was paid'));
  }
  const back = await Payment.findOneAndUpdate(
    { _id: payment._id, status: 'processing' },
    { $set: { status: 'pending' } },
    { new: true },
  );
  res.json(new ApiResponse(200, { status: back?.status ?? 'pending' }, 'Invoice is back under To pay'));
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

  // If the webhook hasn't landed yet but Stripe says paid, reconcile now
  // (only once, even if the webhook lands at the same moment).
  let current = payment;
  if (session.payment_status === 'paid' && payment.status !== 'succeeded') {
    const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    const claimed = await claimPaid(
      { _id: payment._id },
      { stripeCheckoutSessionId: session.id, ...(piId ? { stripePaymentIntentId: piId } : {}) },
    );
    if (claimed) {
      current = claimed;
      await afterPaid(claimed, 'STRIPE_CHECKOUT_RETURN');
    } else {
      current = (await Payment.findById(payment._id)) || payment;
    }
  }

  res.json(new ApiResponse(200, { status: current.status, payment: customerInvoiceView(current) }, 'Checkout status'));
});

// ─── Confirm Payment (dealer, existing Elements path) ─────────────────────────
const confirmPayment = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const { paymentIntentId } = req.body;
  if (!paymentIntentId) throw new ApiError(400, 'paymentIntentId is required');

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
  let payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment record not found');

  if (payment.status === 'succeeded') {
    return res.json(new ApiResponse(200, payment, 'Payment already confirmed'));
  }

  if (paymentIntent.status === 'succeeded') {
    const claimed = await claimPaid({ _id: payment._id }, await paidDetailsFromIntent(paymentIntent));
    // Stripe's own update got there first and already ran the follow-ups.
    if (!claimed) return res.json(new ApiResponse(200, await Payment.findById(payment._id), 'Payment already confirmed'));
    payment = claimed;

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
    payment.failureReason = cardFailureReason(paymentIntent.last_payment_error);
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
// Refunds everything that is left, or `amount` dollars when given. A partly
// refunded payment stays "succeeded" with `refundedAmount` set (2026-11-19):
// it used to be marked "refunded" in full, which made totals and reports wrong.
const refundPayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status !== 'succeeded') throw new ApiError(400, 'Only paid payments can be refunded.');
  if (!payment.stripePaymentIntentId) {
    throw new ApiError(400, "This payment wasn't paid by card through Suprah, so it can't be refunded here. Refund it the same way it was paid.");
  }

  const refundRequest = refundRequestFor(payment, req.body?.amount);
  if (!refundRequest.ok) throw new ApiError(400, refundRequest.message);
  const remainingBefore = remainingRefundable(payment);

  // Without an amount, Stripe refunds exactly what is left on the charge,
  // even if a refund made in the Stripe dashboard hasn't reached us yet.
  const refundParams: Stripe.RefundCreateParams = { payment_intent: payment.stripePaymentIntentId };
  if (refundRequest.explicit) refundParams.amount = Math.round(refundRequest.amount * 100);

  let refund: Stripe.Refund;
  try {
    refund = await stripe.refunds.create(refundParams);
  } catch (error: any) {
    logger.warn({ ...stripeErrorForLog(error), paymentId: payment._id }, 'Stripe refused a refund');
    throw new ApiError(402, refundProblemMessage(error));
  }

  // Our best estimate, then Stripe's own totals when we can read them.
  let state = {
    refundedAmount: roundCents((Number(payment.refundedAmount) || 0) + refundRequest.amount),
    fullyRefunded: !refundRequest.explicit || refundRequest.amount >= remainingBefore,
  };
  try {
    const chargeId = typeof refund.charge === 'string' ? refund.charge : refund.charge?.id;
    if (chargeId) state = refundStateFromCharge(await stripe.charges.retrieve(chargeId));
  } catch { /* Stripe's charge.refunded notice brings the exact totals */ }

  const saved = await Payment.findOneAndUpdate({ _id: payment._id }, refundUpdate(state, new Date()), { new: true });

  const refunded = refundRequest.amount;
  notifyOrgAdmins(
    orgId,
    'general',
    state.fullyRefunded ? 'Payment Refunded' : 'Payment Partly Refunded',
    state.fullyRefunded
      ? `${payment.customerName}'s payment of $${payment.amount.toFixed(2)} was refunded.`
      : `$${refunded.toFixed(2)} of ${payment.customerName}'s $${payment.amount.toFixed(2)} payment was refunded.`,
    { paymentId: payment._id.toString() },
  );

  await activityService.createActivity({
    userId: (req.user?._id as any).toString(),
    organizationId: orgId, type: 'wallet_adjustment',
    title: state.fullyRefunded ? 'Payment Refunded' : 'Payment Partly Refunded',
    description: `Refund of $${refunded.toFixed(2)} processed for ${payment.customerName}`,
    metadata: { paymentId: payment._id.toString(), refundAmount: refunded, refundId: refund.id },
  });

  logger.info({ paymentId: payment._id, amount: refunded, full: state.fullyRefunded }, 'Payment refunded');
  res.json(new ApiResponse(200, saved ?? payment, state.fullyRefunded ? 'Payment refunded' : 'Payment partly refunded'));
});

// ─── Update Payment ───────────────────────────────────────────────────────────
const updatePayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;
  const { status, notes, dueDate } = req.body;

  const payment = await Payment.findOne({ _id: id, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');

  // Only the notes and the due date are edited here (2026-11-20). An invoice is
  // marked paid by Stripe, and refunds and cancellations have their own
  // actions, so a status can't be set by hand (it also paid referral rewards).
  if (status !== undefined && status !== payment.status) {
    throw new ApiError(
      400,
      "An invoice's status can't be changed here. Stripe marks it paid when the customer pays, and Refund and Cancel have their own buttons.",
    );
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    throw new ApiError(400, 'Notes must be text.');
  }
  let due: Date | undefined;
  if (dueDate) {
    due = new Date(dueDate);
    if (Number.isNaN(due.getTime())) throw new ApiError(400, 'Enter a valid due date.');
  }

  if (notes !== undefined) payment.notes = notes ?? undefined;
  if (dueDate !== undefined) payment.dueDate = due;

  await payment.save();

  res.json(new ApiResponse(200, payment, 'Payment updated successfully'));
});

// ─── Payment Stats ────────────────────────────────────────────────────────────
const getPaymentStats = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  // The Payments page's Revenue Trend: money kept from paid payments in each
  // of the last 6 months (2026-11-19: it used to add up only the payments on
  // the current page, whatever their status).
  const trend = lastMonths(new Date(), 6);
  const [stats, monthlyRows] = await Promise.all([
    Payment.aggregate([
      { $match: { organizationId: orgId } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          keptAmount: { $sum: KEPT_AMOUNT },
        },
      },
    ]),
    Payment.aggregate([
      { $match: { organizationId: orgId, status: 'succeeded', createdAt: { $gte: trend.start } } },
      {
        $group: {
          _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
          revenue: { $sum: KEPT_AMOUNT },
        },
      },
    ]),
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
      // Money actually kept: paid payments minus any part refunded later or lost to a dispute.
      if (s._id === 'succeeded') totalRevenue = roundCents(s.keptAmount ?? s.totalAmount);
    }
  });

  res.json(new ApiResponse(200, {
    byStatus: formatted, totalCount, totalRevenue,
    pendingAmount: formatted.pending.totalAmount + formatted.failed.totalAmount,
    monthlyRevenue: fillMonthlyRevenue(trend.months, monthlyRows),
  }, 'Payment statistics fetched successfully'));
});

// ─── Billing Balance ──────────────────────────────────────────────────────────
const getBillingBalance = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const result = await Payment.aggregate([
    { $match: { organizationId: orgId, status: 'succeeded' } },
    // Partly refunded payments count only the part the dealership kept; a lost dispute is left out.
    { $group: { _id: null, balance: { $sum: KEPT_AMOUNT } } },
  ]);
  const balance = roundCents(result[0]?.balance ?? 0);
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
      if (session.payment_status !== 'paid') break;

      let paid: Record<string, unknown> = { stripeCheckoutSessionId: session.id };
      const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
      if (piId) {
        paid.stripePaymentIntentId = piId;
        try {
          paid = { ...paid, ...(await paidDetailsFromIntent(await stripe.paymentIntents.retrieve(piId))) };
        } catch { /* receipt is non-critical */ }
      }

      // Only the first report of this payment runs the follow-ups.
      const payment = await claimPaid(paymentId ? { _id: paymentId } : { stripeCheckoutSessionId: session.id }, paid);
      if (payment) {
        await afterPaid(payment, 'STRIPE_CHECKOUT');
        logger.info({ paymentId: payment._id, sessionId: session.id }, 'Stripe Checkout: payment success');
      }
      break;
    }

    // A customer disputed a card payment with their bank (a chargeback), or
    // the bank's review moved on or ended.
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed': {
      await recordDispute(event.data.object as Stripe.Dispute);
      break;
    }

    // Stripe closed a payment page nobody paid on (it expires after 24 hours):
    // if it was the invoice's latest page, the invoice goes back under "To pay".
    case 'checkout.session.expired': {
      const session = event.data.object as Stripe.Checkout.Session;
      const paymentId = session.metadata?.paymentId;
      await Payment.findOneAndUpdate(
        { ...(paymentId ? { _id: paymentId } : {}), stripeCheckoutSessionId: session.id, status: 'processing' },
        { $set: { status: 'pending' } },
      );
      break;
    }

    case 'payment_intent.succeeded': {
      const pi = event.data.object as Stripe.PaymentIntent;
      const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
      const payment = await claimPaid({ stripePaymentIntentId: pi.id }, chargeId ? { stripeChargeId: chargeId } : {});
      if (payment) {
        await afterPaid(payment, 'STRIPE_WEBHOOK');
        logger.info({ paymentId: payment._id, piId: pi.id }, 'Stripe Webhook: Payment success');
      }
      break;
    }

    case 'payment_intent.payment_failed': {
      const pi = event.data.object as Stripe.PaymentIntent;
      await claimFailed({ stripePaymentIntentId: pi.id }, cardFailureReason(pi.last_payment_error));
      break;
    }

    // Also covers refunds made in the Stripe dashboard. A partial refund keeps
    // the payment "succeeded" and records the amount; a full one marks it
    // "refunded" (2026-11-19: every refund used to mark it refunded in full).
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge;
      const paymentIntentId =
        typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
      if (paymentIntentId) {
        await Payment.findOneAndUpdate(
          { stripePaymentIntentId: paymentIntentId },
          refundUpdate(refundStateFromCharge(charge), new Date()),
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
  // Only an unpaid invoice can be sent to the customer (2026-11-21).
  if (!isAwaitingPayment(payment.status)) throw new ApiError(400, "This invoice isn't waiting for payment, so it can't be sent.");
  // SuprahPay must be on for the dealership; the request says which dealership it's from.
  const dealership = await dealershipForPayments(orgId);

  const customer = await User.findOne({ email: payment.customerEmail.toLowerCase() });
  if (!customer) throw new ApiError(404, 'Customer has not registered an account yet. Ask them to sign up first.');

  const dealer = req.user as IUser;
  const dealerName = dealership.name || dealer?.name || 'the dealer';

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

  // Only what the customer's screens show, plus the dispute amounts that
  // "Total paid" needs (those two are left out of what is sent back).
  const payments = await Payment.find({ customerEmail: user.email.toLowerCase() })
    .select([...CUSTOMER_INVOICE_FIELDS, 'disputeStatus', 'disputedAmount', 'organizationId'].join(' '))
    .populate('aftermarketProductId', 'name media')
    .sort({ createdAt: -1 })
    .lean();

  // Each invoice shows the dealership it's from (2026-11-21): one lookup for all of them.
  const orgIds = [...new Set(payments.map((p) => String(p.organizationId)).filter((id) => mongoose.isValidObjectId(id)))];
  const orgs = orgIds.length
    ? await Organization.find({ _id: { $in: orgIds } }).select('name').lean()
    : [];
  const dealershipNames = new Map(orgs.map((org) => [String(org._id), String(org.name || '')]));
  for (const p of payments as Array<Record<string, unknown>>) {
    p.dealershipName = dealershipNames.get(String(p.organizationId)) || undefined;
  }

  const totalOwed = payments.filter(p => p.status === 'pending' || p.status === 'failed').reduce((s, p) => s + p.amount, 0);
  // Paid minus anything refunded to them since.
  const totalPaid = roundCents(
    payments.filter(p => p.status === 'succeeded').reduce((s, p) => s + keptAmount(p), 0),
  );
  // The same invoices as the "To pay" list on the customer's Suprah Pay page,
  // so the My Garage "Payments Due" tile and that list always agree.
  const pendingCount = payments.filter(p => isAwaitingPayment(p.status)).length;

  res.json(new ApiResponse(
    200,
    { payments: payments.map(customerInvoiceView), stats: { totalOwed, totalPaid, pendingCount } },
    'Payments fetched successfully',
  ));
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
  await refuseRefundedOrOverLimit(payment, 'customer');

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
    // Card only (2026-11-21); Apple Pay and Google Pay come with cards.
    payment_method_types: ['card'],
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
  let payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId });
  if (!payment) throw new ApiError(404, 'Payment record not found');
  if (payment.customerEmail.toLowerCase() !== user.email.toLowerCase()) throw new ApiError(403, 'Not authorized');

  if (payment.status === 'succeeded') return res.json(new ApiResponse(200, customerInvoiceView(payment), 'Payment already confirmed'));

  if (paymentIntent.status === 'succeeded') {
    const claimed = await claimPaid({ _id: payment._id }, await paidDetailsFromIntent(paymentIntent));
    // Stripe's own update got there first and already ran the follow-ups.
    if (!claimed) {
      return res.json(new ApiResponse(200, customerInvoiceView(await Payment.findById(payment._id)), 'Payment already confirmed'));
    }
    payment = claimed;

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
    return res.json(new ApiResponse(200, customerInvoiceView(payment), 'Payment confirmed successfully'));
  }

  if (paymentIntent.status === 'requires_payment_method') {
    payment.status = 'failed';
    payment.failureReason = cardFailureReason(paymentIntent.last_payment_error);
    await payment.save();
    return res.json(new ApiResponse(200, customerInvoiceView(payment), 'Payment failed'));
  }

  payment.status = paymentIntent.status === 'canceled' ? 'cancelled' : 'processing';
  await payment.save();
  res.json(new ApiResponse(200, customerInvoiceView(payment), `Payment status: ${paymentIntent.status}`));
});

// ─── Customer: Cancel an unpaid invoice ───────────────────────────────────────
//
// POST /api/payments/:id/cancel-mine
// Lets a customer cancel their own invoice while it's still unpaid. Guards
// against webhook lag: if Stripe says it was actually paid, we reconcile to
// "succeeded" instead of cancelling.
const cancelMyPayment = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');

  const { id } = req.params;
  const payment = await Payment.findById(id);
  if (!payment) throw new ApiError(404, 'Invoice not found');
  if (payment.customerEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw new ApiError(403, 'You are not authorized to cancel this invoice');
  }
  if (payment.status === 'succeeded') {
    throw new ApiError(400, 'This invoice has already been paid and can’t be cancelled.');
  }
  if (payment.status === 'refunded') {
    throw new ApiError(400, 'This invoice has been refunded.');
  }
  if (payment.status === 'cancelled') {
    return res.json(new ApiResponse(200, customerInvoiceView(payment), 'Invoice already cancelled'));
  }

  // If a Checkout session exists, make sure it didn't just get paid.
  if (payment.stripeCheckoutSessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(payment.stripeCheckoutSessionId);
      if (session.payment_status === 'paid') {
        const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
        const claimed = await claimPaid({ _id: payment._id }, piId ? { stripePaymentIntentId: piId } : {});
        if (claimed) await afterPaid(claimed, 'STRIPE_CANCEL_CHECK');
        throw new ApiError(409, 'This invoice was already paid, so it can’t be cancelled.');
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      // Non-fatal: couldn't reach Stripe — fall through and cancel locally.
    }
  }

  // If a PaymentIntent exists, reconcile if paid, otherwise cancel it on Stripe.
  if (payment.stripePaymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      if (pi.status === 'succeeded') {
        const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
        const claimed = await claimPaid({ _id: payment._id }, chargeId ? { stripeChargeId: chargeId } : {});
        if (claimed) await afterPaid(claimed, 'STRIPE_CANCEL_CHECK');
        throw new ApiError(409, 'This invoice was already paid, so it can’t be cancelled.');
      }
      if (pi.status !== 'canceled') {
        await stripe.paymentIntents.cancel(payment.stripePaymentIntentId).catch(() => {});
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      // Non-fatal: proceed to cancel locally.
    }
  }

  // Cancel only if nothing marked it paid in the meantime (Stripe's update can
  // land while this request is running; saving the old copy would hide a payment).
  const cancelled = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $nin: ['succeeded', 'refunded', 'cancelled'] } },
    { $set: { status: 'cancelled' } },
    { new: true },
  );
  if (!cancelled) {
    const latest = await Payment.findById(payment._id);
    if (latest?.status === 'cancelled') return res.json(new ApiResponse(200, customerInvoiceView(latest), 'Invoice already cancelled'));
    throw new ApiError(409, 'This invoice was already paid, so it can’t be cancelled.');
  }
  payment.status = 'cancelled';

  // Let the dealership know + sync dashboards.
  try {
    notifyOrgAdmins(
      payment.organizationId.toString(),
      'general',
      'Invoice cancelled by customer',
      `${payment.customerName} cancelled invoice ${payment.invoiceNumber || ''} ($${payment.amount.toFixed(2)}).`,
      { paymentId: payment._id.toString(), source: payment.source || 'manual' }
    );
  } catch { /* noop */ }
  try {
    const io = getSocketIO();
    if (io && payment.organizationId) {
      io.to(`org:${payment.organizationId}`).emit('payment:updated', {
        paymentId: payment._id.toString(),
        status: 'cancelled',
      });
    }
  } catch { /* noop */ }
  if (payment.source === 'aftermarket') {
    try {
      getIO().to('crm:staff').emit('aftermarket:invoice_cancelled', {
        paymentId: payment._id.toString(),
        inquiryId: payment.inquiryId ? payment.inquiryId.toString() : null,
      });
    } catch { /* noop */ }
  }

  res.json(new ApiResponse(200, customerInvoiceView(payment), 'Invoice cancelled'));
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
  leaveCheckout,
  cancelMyPayment,
};