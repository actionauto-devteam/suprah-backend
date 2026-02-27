import { Request, Response } from 'express';
import Stripe from 'stripe';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import DriverPayout from '../models/DriverPayout.model';
import Shipment from '../models/Shipment.model';
import User, { IUser } from '../models/User.model';
import config from '../config';

const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2026-01-28.clover',
});

const getUserId = (req: Request): string => {
  const userId = (req.user as IUser)?._id?.toString();
  if (!userId) throw new ApiError(401, 'User not authenticated');
  return userId;
};

/**
 * GET /driver-payouts/deliverable
 * Returns Delivered shipments + shipments with unconfirmed proof, annotated with payout info.
 * pendingConfirmation=true means proof submitted but not yet confirmed by dealer.
 */
const getDeliverableShipments = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  // Include: Delivered shipments OR shipments with proof submitted but not yet confirmed
  const shipments = await Shipment.find({
    organizationId: orgId,
    assignedDriverId: { $exists: true, $ne: null },
    $or: [
      { status: 'Delivered' },
      {
        'proofOfDelivery.imageUrl': { $exists: true, $ne: '' },
        'proofOfDelivery.confirmedAt': { $exists: false },
      },
    ],
  })
    .populate('assignedDriverId', 'name email stripeConnectAccountId')
    .sort({ 'proofOfDelivery.submittedAt': -1, delivered: -1, createdAt: -1 })
    .lean();

  const shipmentIds = shipments.map((s) => s._id);

  // Find existing payouts for these shipments
  const existingPayouts = await DriverPayout.find({
    organizationId: orgId,
    shipmentId: { $in: shipmentIds },
  }).lean();

  const payoutByShipment: Record<string, any> = {};
  existingPayouts.forEach((p) => {
    payoutByShipment[p.shipmentId.toString()] = p;
  });

  const result = shipments.map((s: any) => ({
    ...s,
    existingPayout: payoutByShipment[s._id.toString()] || null,
    // True if proof was submitted but dealer hasn't confirmed yet
    pendingConfirmation: !!(s.proofOfDelivery?.imageUrl && !s.proofOfDelivery?.confirmedAt),
  }));

  res.json(new ApiResponse(200, result, 'Deliverable shipments fetched successfully'));
});

/**
 * POST /driver-payouts
 * Dealer creates a payout for a driver — initiates Stripe Transfer.
 */
const createPayout = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const { shipmentId, driverId, amount, description, notes } = req.body;

  if (!shipmentId || !driverId || !amount) {
    throw new ApiError(400, 'shipmentId, driverId, and amount are required');
  }

  if (amount <= 0) {
    throw new ApiError(400, 'Amount must be greater than zero');
  }

  // Verify shipment belongs to org and is Delivered
  const shipment = await Shipment.findOne({
    _id: shipmentId,
    organizationId: orgId,
    status: 'Delivered',
  });

  if (!shipment) {
    throw new ApiError(404, 'Shipment not found or not yet delivered');
  }

  // Prevent duplicate paid payouts for the same shipment
  const duplicate = await DriverPayout.findOne({
    organizationId: orgId,
    shipmentId,
    status: { $in: ['paid', 'processing'] },
  });

  if (duplicate) {
    throw new ApiError(400, 'A payout has already been sent for this shipment');
  }

  // Load driver
  const driver = await User.findOne({ _id: driverId, role: 'driver' });

  if (!driver) {
    throw new ApiError(404, 'Driver not found');
  }

  if (!driver.stripeConnectAccountId) {
    throw new ApiError(400, 'Driver has not connected a Stripe account yet');
  }

  // Create payout record
  const payout = await DriverPayout.create({
    organizationId: orgId,
    shipmentId,
    driverId,
    driverName: driver.name,
    driverEmail: driver.email,
    amount,
    currency: 'usd',
    description: description || `Driver payout for shipment ${shipment.trackingNumber || shipmentId}`,
    status: 'processing',
    notes,
    createdBy: userId,
  });

  try {
    const transfer = await stripe.transfers.create({
      amount: Math.round(amount * 100),
      currency: 'usd',
      destination: driver.stripeConnectAccountId,
      description: payout.description,
      metadata: {
        payoutId: payout._id.toString(),
        organizationId: orgId,
        shipmentId: shipmentId.toString(),
        driverId: driverId.toString(),
      },
    });

    payout.stripeTransferId = transfer.id;
    payout.status = 'paid';
    payout.paidAt = new Date();
    await payout.save();

    res.status(201).json(new ApiResponse(201, payout, 'Driver payout sent successfully'));
  } catch (stripeError: any) {
    payout.status = 'failed';
    payout.failureReason = stripeError?.message || 'Stripe transfer failed';
    await payout.save();

    throw new ApiError(402, `Payout failed: ${payout.failureReason}`);
  }
});

/**
 * GET /driver-payouts
 * List all driver payouts for the organization.
 */
const getPayouts = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { status, driverId } = req.query;

  const filter: any = { organizationId: orgId };
  if (status && status !== 'all') filter.status = status;
  if (driverId) filter.driverId = driverId;

  const payouts = await DriverPayout.find(filter)
    .populate('driverId', 'name email avatar')
    .populate('shipmentId', 'trackingNumber origin destination')
    .sort({ createdAt: -1 });

  res.json(new ApiResponse(200, payouts, 'Driver payouts fetched successfully'));
});

/**
 * GET /driver-payouts/stats
 * Aggregate payout stats for the organization.
 */
const getPayoutStats = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const stats = await DriverPayout.aggregate([
    { $match: { organizationId: orgId } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount' },
      },
    },
  ]);

  const result = {
    totalPaid: 0,
    totalPending: 0,
    countPaid: 0,
    countPending: 0,
    countFailed: 0,
  };

  stats.forEach((s) => {
    if (s._id === 'paid') {
      result.totalPaid = s.totalAmount;
      result.countPaid = s.count;
    } else if (s._id === 'pending' || s._id === 'processing') {
      result.totalPending += s.totalAmount;
      result.countPending += s.count;
    } else if (s._id === 'failed') {
      result.countFailed = s.count;
    }
  });

  res.json(new ApiResponse(200, result, 'Payout stats fetched successfully'));
});

/**
 * POST /driver-payouts/connect/onboard
 * Driver initiates Stripe Connect Express onboarding.
 */
const initiateDriverOnboarding = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const user = await User.findById(userId);

  if (!user) throw new ApiError(404, 'User not found');
  if (user.role !== 'driver') throw new ApiError(403, 'Only drivers can connect a Stripe account');

  let accountId = user.stripeConnectAccountId;

  if (!accountId) {
    let account;
    try {
      account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        capabilities: {
          transfers: { requested: true },
        },
        metadata: {
          userId: userId,
        },
      });
    } catch (stripeErr: any) {
      // Handle the case where Stripe Connect is not enabled on the platform account
      if (
        stripeErr?.message?.toLowerCase().includes('signed up for connect') ||
        stripeErr?.message?.toLowerCase().includes('connect') ||
        stripeErr?.code === 'account_invalid'
      ) {
        throw new ApiError(
          503,
          'Stripe Connect is not enabled on this platform. Please enable it at dashboard.stripe.com/connect'
        );
      }
      throw new ApiError(500, stripeErr?.message || 'Failed to create Stripe account');
    }

    accountId = account.id;
    user.stripeConnectAccountId = accountId;
    await user.save();
  }

  // CORS_ORIGIN may be comma-separated (multiple allowed origins) — use only the first one
  const rawOrigin = config.frontendUrl || config.corsOrigin || 'http://localhost:3000';
  const frontendUrl = rawOrigin.split(',')[0].trim();

  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${frontendUrl}/driver/settings?stripe=refresh`,
    return_url: `${frontendUrl}/driver/settings?stripe=success`,
    type: 'account_onboarding',
  });

  res.json(new ApiResponse(200, { url: accountLink.url }, 'Stripe onboarding URL generated'));
});

/**
 * GET /driver-payouts/my-payouts
 * Driver fetches their own payout records (no org required — uses logged-in user ID).
 */
const getMyPayouts = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);

  const payouts = await DriverPayout.find({ driverId: userId })
    .populate('shipmentId', 'trackingNumber origin destination')
    .sort({ createdAt: -1 });

  res.json(new ApiResponse(200, payouts, 'My payouts fetched successfully'));
});

/**
 * GET /driver-payouts/connect/status
 * Driver checks their Stripe Connect account status.
 */
const getDriverConnectStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const user = await User.findById(userId);

  if (!user) throw new ApiError(404, 'User not found');

  if (!user.stripeConnectAccountId) {
    return res.json(
      new ApiResponse(200, { connected: false }, 'Driver has not connected a Stripe account')
    );
  }

  try {
    const account = await stripe.accounts.retrieve(user.stripeConnectAccountId);

    res.json(
      new ApiResponse(200, {
        connected: true,
        accountId: account.id,
        detailsSubmitted: account.details_submitted,
        chargesEnabled: account.charges_enabled,
        payoutsEnabled: account.payouts_enabled,
      }, 'Stripe Connect status retrieved')
    );
  } catch (err: any) {
    const isNoSuchAccount =
      err?.code === 'resource_missing' ||
      err?.type === 'StripeInvalidRequestError' ||
      err?.message?.toLowerCase().includes('no such account');

    if (isNoSuchAccount) {
      // Account was deleted from Stripe — safe to clear
      user.stripeConnectAccountId = undefined;
      await user.save();
      return res.json(
        new ApiResponse(200, { connected: false }, 'Stripe account not found, please reconnect')
      );
    }

    // Transient error (network, rate limit, etc.) — do NOT clear the saved account ID
    console.error('[driverPayout] Error retrieving Stripe account:', err?.message);
    res.json(
      new ApiResponse(200, {
        connected: true,
        accountId: user.stripeConnectAccountId,
        detailsSubmitted: false,
        chargesEnabled: false,
        payoutsEnabled: false,
        error: 'Could not verify account status — try again shortly',
      }, 'Stripe status check failed temporarily')
    );
  }
});

export default {
  getDeliverableShipments,
  createPayout,
  getPayouts,
  getPayoutStats,
  getMyPayouts,
  initiateDriverOnboarding,
  getDriverConnectStatus,
};
