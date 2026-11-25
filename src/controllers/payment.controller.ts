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
import { AWAITING_PAYMENT_STATUSES, CUSTOMER_INVOICE_FIELDS, customerInvoiceView, isAwaitingPayment } from '../utils/customerPayments';
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
import { notifySuperAdmins } from '../services/dealershipPayouts.service';
import { SUPPORT_EMAIL } from '../utils/userMessages';
import { SUPRAH_BILLING_ORG, isSuprahBilled } from '../utils/loadBilling';

/** The dealership an invoice belongs to: for Suprah's own shipping invoices, the load's dealership (2026-11-25). */
const dealershipOf = (payment: { organizationId?: unknown; forOrganizationId?: unknown }) =>
  String((isSuprahBilled(payment) ? payment.forOrganizationId : payment.organizationId) ?? '');

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

  // A dealership's own shipping bill from Suprah isn't a customer's payment (2026-11-25).
  if (payment.billedTo !== 'dealership') {
    try { await ReferralService.processPaymentReward(payment, source); }
    catch (e) { logger.error({ err: e, paymentId: payment._id }, 'Referral reward failed after payment'); }
  }

  await activityService.createActivity({
    userId: 'SYSTEM',
    organizationId: dealershipOf(payment),
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
/** Suprah's invoice id saved on a Stripe payment, or null when there isn't a usable one. */
async function invoiceIdOnStripePayment(paymentIntentId: string): Promise<string | null> {
  try {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    const id = intent?.metadata?.paymentId;
    return id && mongoose.isValidObjectId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * A card payment that came in after its invoice was already paid (2026-11-25),
 * for example from a Stripe payment page and the card form both being used.
 * Nothing on the invoice changes; the dealership's admins and Suprah's super
 * admins are told once, so the extra payment can be refunded in Stripe.
 */
async function flagSecondCharge(invoiceId: unknown, paymentIntentId: string | undefined, amountCents: number | null | undefined) {
  if (!paymentIntentId || typeof invoiceId !== 'string' || !mongoose.isValidObjectId(invoiceId)) return;
  const flagged = await Payment.findOneAndUpdate(
    {
      _id: invoiceId,
      status: { $in: ['succeeded', 'refunded'] },
      stripePaymentIntentId: { $exists: true, $ne: paymentIntentId },
      secondChargeIds: { $ne: paymentIntentId },
    },
    { $addToSet: { secondChargeIds: paymentIntentId } },
    { new: true },
  );
  if (!flagged) return;

  const amount = typeof amountCents === 'number' && amountCents > 0 ? ` of $${(amountCents / 100).toFixed(2)}` : '';
  const invoice = flagged.invoiceNumber ? `invoice ${flagged.invoiceNumber}` : 'an invoice';
  logger.warn({ paymentId: String(flagged._id), paymentIntentId }, 'A second card payment came in for a paid invoice');
  try {
    await notifyOrgAdmins(
      dealershipOf(flagged),
      'payment_failed',
      'Customer charged twice',
      `${flagged.customerName} paid ${invoice} a second time${amount}. Suprah has been told so the extra payment can be refunded. If you have questions, contact Suprah AI support at ${SUPPORT_EMAIL}.`,
      { paymentId: String(flagged._id), route: '/billing/payments' },
    );
  } catch { /* the second payment is recorded even if the notice fails */ }
  await notifySuperAdmins(
    'A customer was charged twice',
    `A second card payment${amount} came in for ${invoice}, which was already paid. Refund the extra Stripe payment (${paymentIntentId}) in Stripe's dashboard.`,
  );
}

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
  let before = await Payment.findOneAndUpdate({ $or: match }, disputeUpdate(details, new Date()), { new: false });
  if (!before && piId) {
    // The paid notice may never have arrived, so the card payment isn't on the
    // invoice yet; Stripe's payment carries Suprah's invoice id (2026-11-23).
    const invoiceId = await invoiceIdOnStripePayment(piId);
    if (invoiceId) before = await Payment.findOneAndUpdate({ _id: invoiceId }, disputeUpdate(details, new Date()), { new: false });
  }
  if (!before) {
    logger.warn({ disputeId: dispute.id }, 'Stripe dispute for a payment Suprah does not know');
    return;
  }

  const outcome = disputeOutcome(dispute.status);
  if (before.disputeStatus === outcome && before.stripeDisputeId === dispute.id) return;

  const notice = disputeNotice(before, outcome, details.amount / 100);
  try {
    await notifyOrgAdmins(dealershipOf(before), 'payment_failed', notice.title, notice.message, {
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
    const dealership = dealershipOf(payment);
    if (io && dealership) {
      io.to(`org:${dealership}`).emit('payment:updated', {
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
  // The same invoices as the customer's "To pay" list (2026-11-23): not paid
  // yet, failed, or a payment the customer started but didn't finish.
  const payments = await Payment.find({ organizationId: orgId, status: { $in: [...AWAITING_PAYMENT_STATUSES] } })
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
  // The customer's Stripe payment page is closed first, so the invoice can't
  // be paid there and here (2026-11-25).
  if ((await settleEarlierCheckout(payment)) === 'paid') {
    throw new ApiError(409, 'This invoice was already paid. Refresh to see it.');
  }

  if (payment.stripePaymentIntentId) {
    try {
      const existing = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      if (existing.status !== 'canceled' && existing.status !== 'succeeded') {
        return res.json(new ApiResponse(200, { clientSecret: existing.client_secret, paymentIntentId: existing.id }, 'Existing payment intent retrieved'));
      }
    } catch { /* expired — create new */ }
  }

  const stripeCustomerId = await stripeCustomerFor(payment);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(payment.amount * 100),
    currency: payment.currency,
    customer: stripeCustomerId,
    description: payment.description,
    metadata: { paymentId: payment._id.toString(), organizationId: orgId, invoiceNumber: payment.invoiceNumber || '' },
    // Card only (2026-11-21); Apple Pay and Google Pay come with cards.
    payment_method_types: ['card'],
  });

  await startCardPayment(payment._id, paymentIntent.id, stripeCustomerId);

  res.json(new ApiResponse(200, { clientSecret: paymentIntent.client_secret, paymentIntentId: paymentIntent.id }, 'Payment intent created successfully'));
});

/**
 * Records a card form payment on the invoice, but only while the invoice is
 * still waiting for payment (2026-11-25): a payment confirmed a moment ago is
 * never overwritten. Otherwise the new card payment is cancelled and the
 * request refused. The invoice stays due until the card payment goes through.
 */
async function startCardPayment(paymentId: unknown, paymentIntentId: string, stripeCustomerId: string) {
  const started = await Payment.findOneAndUpdate(
    { _id: paymentId, status: { $in: [...AWAITING_PAYMENT_STATUSES] } },
    { $set: { stripePaymentIntentId: paymentIntentId, stripeCustomerId } },
    { new: true },
  );
  if (started) return started;
  try { await stripe.paymentIntents.cancel(paymentIntentId); } catch { /* nothing was paid with it */ }
  throw new ApiError(409, 'This invoice changed a moment ago (it may have just been paid). Refresh to see it.');
}

/**
 * The invoice's card form payment, before a Stripe payment page opens
 * (2026-11-25): if it went through, the invoice is marked paid (once); if it's
 * still open it is cancelled, so the same invoice can't be paid in both.
 */
async function settleEarlierCardPayment(payment: any): Promise<'paid' | 'closed' | 'none'> {
  if (!payment.stripePaymentIntentId) return 'none';
  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
  } catch (error: any) {
    if (error?.code === 'resource_missing') return 'none';
    throw error;
  }
  if (intent.status === 'processing') {
    throw new ApiError(409, 'A card payment for this invoice is still going through. Please wait a moment, then refresh.');
  }
  if (intent.status !== 'succeeded' && intent.status !== 'canceled') {
    try {
      intent = await stripe.paymentIntents.cancel(intent.id);
    } catch {
      // It may have been paid at this very moment: look again.
      intent = await stripe.paymentIntents.retrieve(intent.id);
    }
  }
  if (intent.status === 'succeeded') {
    const claimed = await claimPaid({ _id: payment._id }, await paidDetailsFromIntent(intent));
    if (claimed) await afterPaid(claimed, 'STRIPE_CARD_CHECK');
    return 'paid';
  }
  if (intent.status !== 'canceled') {
    throw new ApiError(409, 'A card payment for this invoice is still open. Please try again in a moment.');
  }
  return 'closed';
}

// ─── The invoice's Stripe customer ────────────────────────────────────────────
/**
 * The saved Stripe customer while Stripe still has it; otherwise the one with
 * the invoice's email, or a new one (2026-11-23). A customer saved under
 * another Stripe account (for example before a move to a new account) no
 * longer exists, and reusing it would stop the invoice from being paid.
 */
async function stripeCustomerFor(payment: any): Promise<string> {
  const saved = payment.stripeCustomerId;
  if (saved) {
    try {
      const existing = await stripe.customers.retrieve(saved);
      if (!(existing as Stripe.DeletedCustomer).deleted) return saved;
    } catch (error: any) {
      if (error?.code !== 'resource_missing') throw error;
    }
  }
  const customers = await stripe.customers.list({ email: payment.customerEmail, limit: 1 });
  if (customers.data.length > 0) return customers.data[0].id;
  const created = await stripe.customers.create({
    name: payment.customerName,
    email: payment.customerEmail,
    phone: payment.customerPhone,
    metadata: { organizationId: String(payment.organizationId) },
  });
  return created.id;
}

// ─── Build a hosted Stripe Checkout Session for an invoice ────────────────────
// Charges exactly `payment.amount` as a single Checkout line so the total always
// matches the invoice (the itemised breakdown lives in our own UI). Used by both
// the customer "Pay Now" button and "Buy Now".
async function buildCheckoutSession(
  payment: any,
  // Where Stripe sends the payer back (2026-11-25: a dealership pays its bills from Suprah on its SuprahPay page).
  returnTo?: { success: string; cancel: string },
): Promise<Stripe.Checkout.Session> {
  const stripeCustomerId = await stripeCustomerFor(payment);

  // SuprahPay branding with the dealership's name (2026-11-21): the payment
  // page, Stripe's receipt and the card statement say which dealership it's
  // for. A load's shipping invoice shows the load's dealership (2026-11-25).
  const dealershipId = dealershipOf(payment);
  const org = mongoose.isValidObjectId(dealershipId)
    ? await Organization.findById(dealershipId).select('name').lean()
    : null;
  const dealershipName = String(org?.name || '').trim();
  const description = String(payment.description || '').trim();
  const invoiceTitle = payment.invoiceNumber ? `Invoice ${payment.invoiceNumber}` : description || 'Invoice';
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    customer: stripeCustomerId,
    // Card only (2026-11-21); Apple Pay and Google Pay come with cards.
    payment_method_types: ['card'],
    // Not Stripe's Link wallet: it would also offer bank payments and Klarna
    // (cards only, confirmed 2026-11-25).
    wallet_options: { link: { display: 'never' } },
    // US dollars only (2026-11-21): no paying in the customer's local currency.
    adaptive_pricing: { enabled: false },
    // SuprahPay's look (2026-11-25): the dealership's name at the top (B8),
    // SuprahPay's green button and rounded corners, and a SuprahPay line above Pay.
    ...(dealershipName ? { branding_settings: suprahPayPageBranding(dealershipName) } : {}),
    custom_text: { submit: { message: SUPRAHPAY_PAGE_NOTE } },
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
    success_url: returnTo?.success ?? `${CUSTOMER_APP_URL}/customer/payments?status=success&session_id={CHECKOUT_SESSION_ID}`,
    // Coming back without paying puts this invoice back under "To pay".
    cancel_url: returnTo?.cancel ?? `${CUSTOMER_APP_URL}/customer/payments?status=cancelled&invoice=${payment._id.toString()}`,
  };
  const suffix = statementSuffixFor(dealershipName);
  // The card statement wording and the page's look are nice-to-haves: if
  // Stripe refuses either, the page opens without it, never stopping a payment.
  let useSuffix = !!suffix;
  let useLook = true;
  let session: Stripe.Checkout.Session | null = null;
  while (!session) {
    const params: Stripe.Checkout.SessionCreateParams = { ...sessionParams };
    if (useSuffix && suffix) params.payment_intent_data = { ...sessionParams.payment_intent_data, statement_descriptor_suffix: suffix };
    if (!useLook) {
      delete params.branding_settings;
      delete params.custom_text;
    }
    try {
      session = await stripe.checkout.sessions.create(params);
    } catch (error: any) {
      const refused = String(error?.param || error?.message || '');
      if (useLook && /branding_settings|custom_text/i.test(refused)) useLook = false;
      else if (useSuffix && /statement_descriptor/i.test(refused)) useSuffix = false;
      else throw error;
    }
  }

  // Only an invoice still waiting for payment (2026-11-25): one paid a moment
  // ago is never overwritten, and the new page closes. It shows "Payment
  // started" while the customer is on Stripe's page, and goes back to due
  // when they come back to SuprahPay without paying (checkout-return).
  const opened = await Payment.findOneAndUpdate(
    { _id: payment._id, status: { $in: [...AWAITING_PAYMENT_STATUSES] } },
    { $set: { stripeCheckoutSessionId: session.id, stripeCustomerId, status: 'processing' } },
    { new: true },
  );
  if (!opened) {
    try { await stripe.checkout.sessions.expire(session.id); } catch { /* it expires on its own */ }
    throw new ApiError(409, 'This invoice changed a moment ago (it may have just been paid). Refresh to see it.');
  }

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
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(payment.stripeCheckoutSessionId);
  } catch (error: any) {
    // A page Stripe no longer has (for example one made under another Stripe
    // account) has nothing to settle or close (2026-11-23).
    if (error?.code === 'resource_missing') return 'none';
    throw error;
  }
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
  refuseDealershipBill(payment);
  if (payment.status === 'succeeded') throw new ApiError(400, 'This invoice has already been paid');
  if (payment.status === 'cancelled') throw new ApiError(400, 'This invoice has been cancelled');
  await refuseRefundedOrOverLimit(payment, 'customer');

  // A payment page was opened before: make sure it wasn't paid, and close it.
  if ((await settleEarlierCheckout(payment)) === 'paid') {
    throw new ApiError(409, 'This invoice was already paid. Refresh to see your receipt.');
  }
  // So was the card form (2026-11-25): one invoice can't be paid in both.
  if ((await settleEarlierCardPayment(payment)) === 'paid') {
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
  if (!isAwaitingPayment(payment.status) || !payment.stripeCheckoutSessionId) {
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

  // Not paid: the invoice changes only while it's still waiting for payment
  // (2026-11-25), so a payment confirmed a moment ago is never overwritten.
  const current = await cardFormResult(payment._id, paymentIntent);
  res.json(new ApiResponse(
    200,
    current,
    paymentIntent.status === 'requires_payment_method' ? 'Payment failed - new payment method required' : `Payment status: ${paymentIntent.status}`,
  ));
});

/**
 * What a card form payment that didn't go through means for its invoice
 * (2026-11-25): declined → failed; still going through → payment started. A
 * cancelled card payment leaves the invoice as it is (a Stripe payment page
 * may have replaced it). Nothing changes once the invoice is paid, refunded
 * or cancelled. Returns the invoice as it is now.
 */
async function cardFormResult(paymentId: unknown, intent: Stripe.PaymentIntent) {
  let updated = null;
  if (intent.status === 'requires_payment_method') {
    updated = await claimFailed({ _id: paymentId, stripePaymentIntentId: intent.id }, cardFailureReason(intent.last_payment_error));
  } else if (intent.status !== 'canceled') {
    updated = await Payment.findOneAndUpdate(
      { _id: paymentId, stripePaymentIntentId: intent.id, status: { $in: [...AWAITING_PAYMENT_STATUSES] } },
      { $set: { status: 'processing' } },
      { new: true },
    );
  }
  return updated ?? (await Payment.findById(paymentId));
}

// ─── Cancel Payment ───────────────────────────────────────────────────────────
const cancelPayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;
  const payment = await Payment.findOne({ _id: id, organizationId: orgId });
  if (!payment) throw new ApiError(404, 'Payment not found');
  if (payment.status === 'succeeded') throw new ApiError(400, 'Cannot cancel a completed payment. Use refund instead.');
  // Only an invoice still waiting for payment can be cancelled (2026-11-23):
  // a refunded or cancelled one keeps its status, so payouts stay right.
  if (!isAwaitingPayment(payment.status)) {
    throw new ApiError(400, "Only an invoice that's still waiting for payment can be cancelled.");
  }

  // Close the customer's Stripe payment page if it's still open, so a
  // cancelled invoice can't be paid there (the customer's own Cancel does the
  // same). If they've just paid, the invoice is marked paid instead.
  let earlier: Awaited<ReturnType<typeof settleEarlierCheckout>>;
  try {
    earlier = await settleEarlierCheckout(payment);
  } catch {
    throw new ApiError(409, "The customer's payment page couldn't be checked, so the invoice wasn't cancelled. Try again in a moment.");
  }
  if (earlier === 'paid') {
    throw new ApiError(409, 'The customer has just paid this invoice, so it was marked paid instead of cancelled. Refresh to see it.');
  }

  if (payment.stripePaymentIntentId) {
    try { await stripe.paymentIntents.cancel(payment.stripePaymentIntentId); } catch { /* already cancelled */ }
  }

  // Cancelled only if it's still waiting: a payment confirmed a moment ago wins.
  const cancelled = await Payment.findOneAndUpdate(
    { _id: payment._id, organizationId: orgId, status: { $in: [...AWAITING_PAYMENT_STATUSES] } },
    { $set: { status: 'cancelled' } },
    { new: true },
  );
  if (!cancelled) {
    throw new ApiError(409, 'This invoice changed a moment ago (it may have just been paid). Refresh to see it.');
  }
  payment.status = 'cancelled';

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

  // Saved, and the dealership's admins and the customer told, once: Stripe's
  // refund notice for this same refund may land first (2026-11-25).
  const saved = await recordRefund({ _id: payment._id }, state);
  const refunded = refundRequest.amount;

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

/**
 * Saves a refund's new total and tells the dealership's admins and the
 * customer (decision B5), once per refund (2026-11-25). Suprah's Refund button
 * and Stripe's refund notice (also sent for refunds made in Stripe's
 * dashboard) can land in either order, or twice: whichever raises the total
 * sends the notices. Returns the invoice as it is now, or null when Suprah
 * doesn't know the payment.
 */
async function recordRefund(filter: Record<string, unknown>, state: { refundedAmount: number; fullyRefunded: boolean }) {
  const at = new Date();
  const before = await Payment.findOneAndUpdate(
    {
      ...filter,
      $or: [{ refundedAmount: { $lt: state.refundedAmount } }, { refundedAmount: { $exists: false } }, { refundedAmount: null }],
    },
    refundUpdate(state, at),
    { new: false },
  );
  if (!before) {
    // Already recorded by the other path: keep the status right, tell nobody again.
    return Payment.findOneAndUpdate(filter, refundUpdate(state, at), { new: true });
  }

  const orgId = dealershipOf(before);
  const amount = Number(before.amount) || 0;
  const refunded = roundCents(state.refundedAmount - (Number(before.refundedAmount) || 0));
  notifyOrgAdmins(
    orgId,
    'general',
    state.fullyRefunded ? 'Payment Refunded' : 'Payment Partly Refunded',
    state.fullyRefunded
      ? `${before.customerName}'s payment of $${amount.toFixed(2)} was refunded.`
      : `$${refunded.toFixed(2)} of ${before.customerName}'s $${amount.toFixed(2)} payment was refunded.`,
    { paymentId: String(before._id) },
  );
  // How much, from which dealership, and that it can take 5-10 business days to show on their card.
  // A dealership's own bill from Suprah is told to its admins above, not to one person (2026-11-25).
  if (before.billedTo !== 'dealership') {
    void notifyCustomerOfRefund(before, refunded, orgId);
  }
  return (await Payment.findById(before._id)) ?? before;
}

/**
 * Tells the customer their refund is on its way (2026-11-23, decision B5).
 * Only a verified account with the invoice's email gets it, the same rule as
 * seeing the invoice. A failed notice never undoes the refund.
 */
async function notifyCustomerOfRefund(
  payment: { _id: unknown; customerEmail?: string; description?: string; invoiceNumber?: string },
  refunded: number,
  orgId: string,
  issuer?: string,
) {
  try {
    const email = String(payment.customerEmail ?? '').toLowerCase();
    if (!email) return;
    const customer = await User.findOne({ email, emailVerified: true }).select('_id').lean();
    if (!customer) return;
    // Suprah's own shipping invoices are refunded by Suprah AI (2026-11-25).
    const name = issuer ?? (mongoose.isValidObjectId(orgId) ? (await Organization.findById(orgId).select('name').lean())?.name : undefined);
    const from = name ? ` by ${name}` : '';
    const what = payment.description ? ` for "${payment.description}"` : '';
    await safeCreateNotification({
      userId: customer._id as any,
      organizationId: orgId,
      type: 'payment_refunded',
      title: 'Your refund is on its way',
      message: `$${refunded.toFixed(2)} was refunded to you${from}${what}. It can take 5–10 business days to show on your card.`,
      metadata: {
        paymentId: String(payment._id),
        invoiceNumber: payment.invoiceNumber,
        amount: refunded,
        route: '/customer/payments',
      },
    });
  } catch {
    logger.warn({ paymentId: String(payment._id) }, 'Customer refund notice not sent');
  }
}

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
    // Everything still to be paid, the same invoices as Awaiting payment (2026-11-23).
    pendingAmount: roundCents(formatted.pending.totalAmount + formatted.failed.totalAmount + formatted.processing.totalAmount),
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
      } else {
        // Already paid: if by a different card payment, someone was charged twice (2026-11-25).
        await flagSecondCharge(paymentId, piId, session.amount_total);
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
      let payment = await claimPaid({ stripePaymentIntentId: pi.id }, chargeId ? { stripeChargeId: chargeId } : {});
      const invoiceId = pi.metadata?.paymentId;
      if (!payment && invoiceId && mongoose.isValidObjectId(invoiceId)) {
        // Not the card payment saved on the invoice (2026-11-25): Stripe's
        // payment carries Suprah's invoice id. An unpaid invoice is paid by
        // it; an invoice already paid by another card payment means a second
        // charge (the same payment reported twice changes nothing).
        payment = await claimPaid({ _id: invoiceId }, { stripePaymentIntentId: pi.id, ...(await paidDetailsFromIntent(pi)) });
        if (!payment) await flagSecondCharge(invoiceId, pi.id, pi.amount_received ?? pi.amount);
      }
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
        // A refund made in Stripe's dashboard tells the same people (2026-11-25).
        await recordRefund({ stripePaymentIntentId: paymentIntentId }, refundStateFromCharge(charge));
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
    // SuprahPay branding with the dealership's name (decision B8, 2026-11-23).
    userId: customer._id as any, organizationId: orgId, type: 'payment_request', title: `SuprahPay invoice from ${dealerName}`,
    message: `${dealerName} sent you an invoice of $${payment.amount.toFixed(2)} for "${payment.description}". Open SuprahPay to pay it.`,
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
  // A dealership's own bills from Suprah aren't a person's invoices (2026-11-25).
  const payments = await Payment.find({ customerEmail: user.email.toLowerCase(), billedTo: { $ne: 'dealership' } })
    .select([...CUSTOMER_INVOICE_FIELDS, 'disputeStatus', 'disputedAmount', 'organizationId', 'forOrganizationId'].join(' '))
    .populate('aftermarketProductId', 'name media')
    .sort({ createdAt: -1 })
    .lean();

  // Each invoice shows the dealership it's from (2026-11-21): one lookup for all of them.
  // A load's shipping invoice is from the load's dealership (2026-11-25).
  const orgIds = [...new Set(payments.map((p) => dealershipOf(p)).filter((id) => mongoose.isValidObjectId(id)))];
  const orgs = orgIds.length
    ? await Organization.find({ _id: { $in: orgIds } }).select('name').lean()
    : [];
  const dealershipNames = new Map(orgs.map((org) => [String(org._id), String(org.name || '')]));
  for (const p of payments as Array<Record<string, unknown>>) {
    p.dealershipName = dealershipNames.get(dealershipOf(p)) || undefined;
  }

  // Owed = the "To pay" list, so the total and the list always agree (2026-11-23).
  const totalOwed = roundCents(payments.filter(p => isAwaitingPayment(p.status)).reduce((s, p) => s + p.amount, 0));
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

/**
 * "Payment started" invoices whose Stripe page wasn't paid (the customer
 * closed the tab, or it expired) go back to due; one Stripe says was paid is
 * marked paid, once. A card form payment that's really going through (a bank
 * still processing it) stays as it is. A few at a time; never blocks the list.
 */
async function releaseAbandonedCheckouts(
  started: Array<{ _id: unknown; stripeCheckoutSessionId?: string | null; stripePaymentIntentId?: string | null }>,
): Promise<Map<string, 'pending' | 'succeeded'>> {
  const settled = new Map<string, 'pending' | 'succeeded'>();
  try {
    for (const payment of started) {
      if (!payment.stripeCheckoutSessionId) continue;
      try {
        const session = await stripe.checkout.sessions.retrieve(payment.stripeCheckoutSessionId);
        if (session.payment_status === 'paid') {
          const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
          const claimed = await claimPaid({ _id: payment._id }, { stripeCheckoutSessionId: session.id, ...(piId ? { stripePaymentIntentId: piId } : {}) });
          // Paid, whatever happens to the follow-ups (notices, rewards).
          settled.set(String(payment._id), 'succeeded');
          if (claimed) await afterPaid(claimed, 'STRIPE_CHECKOUT_CHECK');
          continue;
        }
        if (payment.stripePaymentIntentId) {
          const intent = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
          if (intent.status === 'processing') continue;
        }
        const back = await Payment.updateOne({ _id: payment._id, status: 'processing' }, { $set: { status: 'pending' } });
        if (back?.modifiedCount) settled.set(String(payment._id), 'pending');
      } catch {
        // Checked again the next time the customer opens SuprahPay.
      }
    }
  } catch (error) {
    logger.warn({ err: (error as Error)?.message }, 'Could not check payment pages left open');
  }
  return settled;
}

// POST /api/payments/checkout-return — the customer is back on SuprahPay
// (2026-11-25). Since pressing Pay takes them to Stripe's page in the same
// tab, being back means they left it: their "Payment started" invoices go
// back to due (or to paid, if Stripe says they were paid).
const returnFromCheckout = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  if (!user?.email) throw new ApiError(401, 'User not authenticated');
  const started = await Payment.find({
    customerEmail: user.email.toLowerCase(),
    status: 'processing',
    stripeCheckoutSessionId: { $exists: true, $ne: null },
    billedTo: { $ne: 'dealership' },
  })
    .select('_id stripeCheckoutSessionId stripePaymentIntentId')
    .limit(5)
    .lean();
  const settled = await releaseAbandonedCheckouts(started);
  res.json(new ApiResponse(200, { changed: settled.size }, 'Checked'));
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
  refuseDealershipBill(payment);
  if (payment.status === 'succeeded') throw new ApiError(400, 'This payment has already been completed');
  if (payment.status === 'cancelled') throw new ApiError(400, 'This payment has been cancelled');
  await refuseRefundedOrOverLimit(payment, 'customer');
  // The Stripe payment page is closed first, so the invoice can't be paid
  // there and in this card form (2026-11-25).
  if ((await settleEarlierCheckout(payment)) === 'paid') {
    throw new ApiError(409, 'This invoice was already paid. Refresh to see your receipt.');
  }

  if (payment.stripePaymentIntentId) {
    try {
      const existing = await stripe.paymentIntents.retrieve(payment.stripePaymentIntentId);
      if (existing.status !== 'canceled' && existing.status !== 'succeeded') {
        return res.json(new ApiResponse(200, { clientSecret: existing.client_secret, paymentIntentId: existing.id }, 'Existing payment intent retrieved'));
      }
    } catch { /* create new */ }
  }

  const stripeCustomerId = await stripeCustomerFor(payment);

  const paymentIntent = await stripe.paymentIntents.create({
    amount: Math.round(payment.amount * 100),
    currency: payment.currency,
    customer: stripeCustomerId,
    description: payment.description,
    metadata: { paymentId: payment._id.toString(), invoiceNumber: payment.invoiceNumber || '' },
    // Card only (2026-11-21); Apple Pay and Google Pay come with cards.
    payment_method_types: ['card'],
  });

  await startCardPayment(payment._id, paymentIntent.id, stripeCustomerId);

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

  // Not paid: only an invoice still waiting for payment changes (2026-11-25).
  const current = await cardFormResult(payment._id, paymentIntent);
  res.json(new ApiResponse(
    200,
    customerInvoiceView(current ?? payment),
    paymentIntent.status === 'requires_payment_method' ? 'Payment failed' : `Payment status: ${paymentIntent.status}`,
  ));
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
  refuseDealershipBill(payment);
  if (payment.billedTo === 'customer') {
    // A booked load's shipping invoice is cancelled with the load (2026-11-25).
    throw new ApiError(400, "This is the shipping invoice for a booked shipment, so it can't be cancelled here. If the shipment is off, contact the dealership.");
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

// ─── Shipping Suprah bills for loads (2026-11-25) ─────────────────────────────

/** SuprahPay's look on Stripe's payment page: the dealership's name (B8), green button, rounded corners. */
function suprahPayPageBranding(dealershipName: string): Stripe.Checkout.SessionCreateParams.BrandingSettings {
  return {
    display_name: dealershipName.slice(0, 100),
    button_color: '#16A34A',
    border_style: 'rounded',
    font_family: 'be_vietnam_pro',
  };
}
const SUPRAHPAY_PAGE_NOTE =
  "Secured by SuprahPay, Suprah AI's payment service. Your card details go straight to Stripe; Suprah never stores them.";

/** A dealership's bill from Suprah is paid on the dealership's SuprahPay page, not from a personal account. */
function refuseDealershipBill(payment: { billedTo?: string }) {
  if (payment.billedTo === 'dealership') {
    throw new ApiError(403, "This is your dealership's bill from Suprah. Pay it on your dealership's SuprahPay page.");
  }
}

/**
 * Closes an invoice's open Stripe payment page and card form payment, for
 * example before a load's shipping invoice is cancelled or replaced. 'paid'
 * when one of them was paid a moment ago (it's then marked paid, once).
 */
export async function closeOpenPaymentPages(payment: any): Promise<'paid' | 'closed'> {
  if ((await settleEarlierCheckout(payment)) === 'paid') return 'paid';
  if ((await settleEarlierCardPayment(payment)) === 'paid') return 'paid';
  return 'closed';
}

const SUPRAH_BILL_FIELDS = 'amount status invoiceNumber description loadId createdAt paidAt failureReason refundedAmount billedTo';

/** The dealership's bill from Suprah, found only within the signed-in person's dealership. */
async function dealershipBill(req: Request) {
  const orgId = req.orgId as string;
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'That bill could not be found.');
  const bill = await Payment.findOne({ _id: req.params.id, organizationId: SUPRAH_BILLING_ORG, forOrganizationId: orgId, billedTo: 'dealership' });
  if (!bill) throw new ApiError(404, 'That bill could not be found.');
  return bill;
}

// GET /api/payments/suprah-bills — the dealership's shipping bills from Suprah (staff).
const getSuprahBills = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const bills = await Payment.find({ organizationId: SUPRAH_BILLING_ORG, forOrganizationId: orgId, billedTo: 'dealership' })
    .select(SUPRAH_BILL_FIELDS)
    .populate('loadId', 'loadNumber status')
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json(new ApiResponse(200, bills, 'Bills from Suprah'));
});

// POST /api/payments/suprah-bills/:id/pay — opens Stripe's payment page (admins and staff with Finance access).
const paySuprahBill = asyncHandler(async (req: Request, res: Response) => {
  const bill = await dealershipBill(req);
  if (bill.status === 'succeeded') throw new ApiError(400, 'This bill is already paid.');
  if (!isAwaitingPayment(bill.status)) throw new ApiError(400, "This bill isn't waiting for payment any more.");
  await refuseRefundedOrOverLimit(bill, 'staff');
  if ((await closeOpenPaymentPages(bill)) === 'paid') {
    throw new ApiError(409, 'This bill was just paid. Refresh to see it.');
  }
  const back = `${CUSTOMER_APP_URL}/billing?bill=${bill._id.toString()}`;
  const session = await buildCheckoutSession(bill, { success: `${back}&billStatus=paid`, cancel: `${back}&billStatus=left` });
  res.json(new ApiResponse(200, { url: session.url }, 'Payment page ready'));
});

// POST /api/payments/suprah-bills/:id/check — back from Stripe's page: paid, or put back to unpaid.
const checkSuprahBill = asyncHandler(async (req: Request, res: Response) => {
  const bill = await dealershipBill(req);
  if (!isAwaitingPayment(bill.status) || !bill.stripeCheckoutSessionId) {
    return res.json(new ApiResponse(200, { status: bill.status }, 'Bill status'));
  }
  const session = await stripe.checkout.sessions.retrieve(bill.stripeCheckoutSessionId);
  if (session.payment_status === 'paid') {
    const piId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    const claimed = await claimPaid({ _id: bill._id }, { stripeCheckoutSessionId: session.id, ...(piId ? { stripePaymentIntentId: piId } : {}) });
    if (claimed) await afterPaid(claimed, 'STRIPE_CHECKOUT_RETURN');
    return res.json(new ApiResponse(200, { status: 'succeeded' }, 'Bill paid'));
  }
  if (req.body?.left === true) {
    // Left Stripe's page without paying: close it and put the bill back as unpaid.
    if ((await settleEarlierCheckout(bill)) === 'paid') return res.json(new ApiResponse(200, { status: 'succeeded' }, 'Bill paid'));
    const back = await Payment.findOneAndUpdate({ _id: bill._id, status: 'processing' }, { $set: { status: 'pending' } }, { new: true });
    return res.json(new ApiResponse(200, { status: back?.status ?? 'pending' }, 'Bill is unpaid'));
  }
  res.json(new ApiResponse(200, { status: bill.status }, 'Bill status'));
});

export default {
  getSuprahBills,
  paySuprahBill,
  checkSuprahBill,
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
  returnFromCheckout,
  cancelMyPayment,
};