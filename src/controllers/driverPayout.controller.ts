import { Request, Response } from 'express';
import Stripe from 'stripe';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import DriverPayout from '../models/DriverPayout.model';
import Shipment from '../models/Shipment.model';
import Load from '../models/Load.model';
import User, { IUser } from '../models/User.model';
import { safeCreateNotification } from '../utils/safeNotification';
import { notifyOrgAdmins } from '../utils/safeNotification';
import activityService from '../services/activity.service';
import config from '../config';
import logger from '../utils/logger';
import { storageService } from '../services/storage.service';

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

  const deliverableFilter = {
    assignedDriverId: { $exists: true, $ne: null },
    $or: [
      { status: 'Delivered' },
      {
        'proofOfDelivery.imageUrl': { $exists: true, $ne: '' },
        'proofOfDelivery.confirmedAt': { $exists: true },
      },
    ],
  };

  const [shipments, loads] = await Promise.all([
    Shipment.find({ organizationId: orgId, ...deliverableFilter })
      .populate('assignedDriverId', 'name email stripeConnectAccountId')
      .sort({ 'proofOfDelivery.submittedAt': -1, createdAt: -1 })
      .lean(),
    Load.find({ organizationId: orgId, ...deliverableFilter })
      .populate('assignedDriverId', 'name email stripeConnectAccountId')
      .sort({ 'proofOfDelivery.submittedAt': -1, createdAt: -1 })
      .lean(),
  ]);

  const allItems: any[] = [
    ...shipments,
    ...loads.map((l: any) => ({
      ...l,
      _type: 'load',
      trackingNumber: l.loadNumber,
      origin: l.pickupLocation ? `${l.pickupLocation.city}, ${l.pickupLocation.state}` : undefined,
      destination: l.deliveryLocation ? `${l.deliveryLocation.city}, ${l.deliveryLocation.state}` : undefined,
    })),
  ];

  const allIds = allItems.map((i) => i._id);
  const existingPayouts = await DriverPayout.find({ organizationId: orgId, shipmentId: { $in: allIds } }).lean();
  const payoutByEntity: Record<string, any> = {};
  existingPayouts.forEach((p) => { payoutByEntity[p.shipmentId.toString()] = p; });

  const result = allItems.map((s) => ({
    ...s,
    existingPayout: payoutByEntity[s._id.toString()] || null,
    pendingConfirmation: !!(s.proofOfDelivery?.imageUrl && !s.proofOfDelivery?.confirmedAt),
  }));

  res.json(new ApiResponse(200, result, 'Deliverable shipments fetched successfully'));
});

/**
 * GET /driver-payouts/pending-proofs
 * Returns Loads+Shipments where proof was submitted to this specific admin and not yet confirmed.
 */
const getPendingProofs = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;

  const proofFilter = {
    organizationId: orgId,
    'proofOfDelivery.imageUrl': { $exists: true, $ne: '' },
    'proofOfDelivery.confirmedAt': { $exists: false },
    'proofOfDelivery.submittedTo': userId,
  };

  const [shipments, loads] = await Promise.all([
    Shipment.find(proofFilter)
      .populate('assignedDriverId', 'name email')
      .sort({ 'proofOfDelivery.submittedAt': -1 })
      .lean(),
    Load.find(proofFilter)
      .populate('assignedDriverId', 'name email')
      .sort({ 'proofOfDelivery.submittedAt': -1 })
      .lean(),
  ]);

  // Sign all proof image URLs so the frontend can display them directly
  const signUrl = async (item: any): Promise<any> => {
    if (item.proofOfDelivery?.imageUrl && !item.proofOfDelivery.imageUrl.startsWith('http')) {
      try {
        const signed = await storageService.getSignedUrl(item.proofOfDelivery.imageUrl);
        if (signed) return { ...item, proofOfDelivery: { ...item.proofOfDelivery, imageUrl: signed } };
      } catch { /* non-fatal */ }
    }
    return item;
  };

  const normalizedLoads = loads.map((l: any) => ({
    ...l,
    _type: 'load',
    trackingNumber: l.loadNumber,
    origin: l.pickupLocation ? `${l.pickupLocation.city}, ${l.pickupLocation.state}` : undefined,
    destination: l.deliveryLocation ? `${l.deliveryLocation.city}, ${l.deliveryLocation.state}` : undefined,
  }));

  const combined = await Promise.all(
    [...shipments, ...normalizedLoads]
      .sort((a: any, b: any) => new Date(b.proofOfDelivery?.submittedAt).getTime() - new Date(a.proofOfDelivery?.submittedAt).getTime())
      .map(signUrl)
  );

  res.json(new ApiResponse(200, combined, 'Pending proofs fetched successfully'));
});

/**
 * GET /driver-payouts/org-admins
 * Returns list of org admins/employees for the driver's "Submit To" dropdown.
 */
const getOrgAdmins = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const admins = await User.find({
    organizationId: orgId,
    role: { $in: ['admin', 'super_admin', 'employee'] },
    isActive: true,
  }).select('_id name email role').lean();
  res.json(new ApiResponse(200, admins, 'Org admins fetched'));
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

    safeCreateNotification({
      userId: driverId,
      organizationId: orgId,
      type: 'driver_payout',
      title: 'Payout Received',
      message: `You received a payout of $${amount.toFixed(2)} for shipment ${shipment.trackingNumber || shipmentId}`,
      metadata: { shipmentId, amount },
    });

    // Log activity (Persona: Driver receiving money)
    await activityService.logFinancialActivity(
      driverId,
      orgId,
      'payout_received',
      amount,
      `Received payout for shipment ${shipment.trackingNumber || shipmentId}`,
      { shipmentId: shipment._id.toString(), payoutId: payout._id.toString() }
    );

    logger.info({ payoutId: payout._id, driverId, amount }, 'Driver payout sent successfully');

    res.status(201).json(new ApiResponse(201, payout, 'Driver payout sent successfully'));
  } catch (stripeError: any) {
    payout.status = 'failed';
    payout.failureReason = stripeError?.message || 'Stripe transfer failed';
    await payout.save();

    logger.error({ err: stripeError, payoutId: payout._id, driverId }, 'Driver payout failed');

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

  logger.info({ userId, accountId }, 'Driver onboarding URL generated');

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
  getPendingProofs,
  getOrgAdmins,
  createPayout,
  getPayouts,
  getPayoutStats,
  getMyPayouts,
  initiateDriverOnboarding,
  getDriverConnectStatus,
};
