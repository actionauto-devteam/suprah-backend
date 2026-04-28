import { Request, Response } from 'express';
import Stripe from 'stripe';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import DriverPayout from '../models/DriverPayout.model';
import Load from '../models/Load.model';
import User, { IUser } from '../models/User.model';
import { safeCreateNotification } from '../utils/safeNotification';
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
 * Returns Delivered loads, annotated with payout info.
 */
const getDeliverableLoads = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const deliverableFilter = {
    organizationId: orgId,
    assignedDriverId: { $exists: true, $ne: null },
    status: 'Delivered',
  };

  const loads = await Load.find(deliverableFilter)
    .populate('assignedDriverId', 'name email stripeConnectAccountId')
    .sort({ deliveredAt: -1, createdAt: -1 })
    .lean();

  const allItems = loads.map((l: any) => ({
    ...l,
    _type: 'load',
    trackingNumber: l.loadNumber,
    origin: l.pickupLocation ? `${l.pickupLocation.city}, ${l.pickupLocation.state}` : undefined,
    destination: l.deliveryLocation ? `${l.deliveryLocation.city}, ${l.deliveryLocation.state}` : undefined,
  }));

  const allIds = allItems.map((i) => i._id);
  const existingPayouts = await DriverPayout.find({ organizationId: orgId, loadId: { $in: allIds } }).lean();
  const payoutByEntity: Record<string, any> = {};
  existingPayouts.forEach((p) => { payoutByEntity[p.loadId.toString()] = p; });

  const result = allItems.map((s) => ({
    ...s,
    existingPayout: payoutByEntity[s._id.toString()] || null,
    pendingConfirmation: !!(s.proofOfDelivery?.imageUrl && !s.proofOfDelivery?.confirmedAt),
  }));

  res.json(new ApiResponse(200, result, 'Deliverable loads fetched successfully'));
});

/**
 * GET /driver-payouts/pending-proofs
 * Returns Loads where proof was submitted to this specific admin and not yet confirmed.
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

  const loads = await Load.find(proofFilter)
    .populate('assignedDriverId', 'name email')
    .sort({ 'proofOfDelivery.submittedAt': -1 })
    .lean();

  const signUrl = async (item: any): Promise<any> => {
    if (item.proofOfDelivery?.imageUrl && !item.proofOfDelivery.imageUrl.startsWith('http')) {
      try {
        const signed = await storageService.getSignedUrl(item.proofOfDelivery.imageUrl);
        if (signed) return { ...item, proofOfDelivery: { ...item.proofOfDelivery, imageUrl: signed } };
      } catch { /* ignored */ }
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
    normalizedLoads
      .sort((a: any, b: any) => new Date(b.proofOfDelivery?.submittedAt).getTime() - new Date(a.proofOfDelivery?.submittedAt).getTime())
      .map(signUrl)
  );

  res.json(new ApiResponse(200, combined, 'Pending proofs fetched successfully'));
});

/**
 * GET /driver-payouts/org-admins
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
 */
const createPayout = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const { loadId, driverId, amount, description, notes } = req.body;

  if (!loadId || !driverId || !amount) {
    throw new ApiError(400, 'loadId, driverId, and amount are required');
  }

  const load = await Load.findOne({ _id: loadId, organizationId: orgId, status: 'Delivered' });
  if (!load) throw new ApiError(404, 'Load not found or not delivered');

  const duplicate = await DriverPayout.findOne({ organizationId: orgId, loadId, status: { $in: ['paid', 'processing'] } });
  if (duplicate) throw new ApiError(400, 'Payout already processing or paid for this load');

  const driver = await User.findOne({ _id: driverId, role: 'driver' });
  if (!driver) throw new ApiError(404, 'Driver not found');
  if (!driver.stripeConnectAccountId) throw new ApiError(400, 'Driver has no Stripe Connect account');

  const payout = await DriverPayout.create({
    organizationId: orgId,
    loadId,
    driverId,
    driverName: driver.name,
    driverEmail: driver.email,
    amount,
    currency: 'usd',
    description: description || `Payout for load ${load.loadNumber}`,
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
      metadata: { payoutId: payout._id.toString(), loadId: loadId.toString() },
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
      message: `You received a payout of $${amount.toFixed(2)} for load ${load.loadNumber}`,
      metadata: { loadId, amount },
    });

    await activityService.logFinancialActivity(driverId, orgId, 'payout_received', amount, `Received payout for load ${load.loadNumber}`, { loadId: load._id.toString(), payoutId: payout._id.toString() });

    res.status(201).json(new ApiResponse(201, payout, 'Payout sent successfully'));
  } catch (stripeError: any) {
    payout.status = 'failed';
    payout.failureReason = stripeError?.message || 'Stripe transfer failed';
    await payout.save();
    throw new ApiError(402, `Payout failed: ${payout.failureReason}`);
  }
});

const getPayouts = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { status, driverId } = req.query;

  const filter: any = { organizationId: orgId };
  if (status && status !== 'all') filter.status = status;
  if (driverId) filter.driverId = driverId;

  const payouts = await DriverPayout.find(filter)
    .populate('driverId', 'name email avatar')
    .populate('loadId', 'loadNumber pickupLocation deliveryLocation')
    .sort({ createdAt: -1 });

  res.json(new ApiResponse(200, payouts, 'Payouts fetched successfully'));
});

const getPayoutStats = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const stats = await DriverPayout.aggregate([
    { $match: { organizationId: orgId } },
    { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: '$amount' } } },
  ]);

  const result = { totalPaid: 0, totalPending: 0, countPaid: 0, countPending: 0, countFailed: 0 };
  stats.forEach((s) => {
    if (s._id === 'paid') { result.totalPaid = s.totalAmount; result.countPaid = s.count; }
    else if (['pending', 'processing'].includes(s._id)) { result.totalPending += s.totalAmount; result.countPending += s.count; }
    else if (s._id === 'failed') { result.countFailed = s.count; }
  });

  res.json(new ApiResponse(200, result, 'Stats fetched'));
});

const initiateDriverOnboarding = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const user = await User.findById(userId);
  if (!user || user.role !== 'driver') throw new ApiError(403, 'Invalid driver');

  let accountId = user.stripeConnectAccountId;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express', email: user.email, capabilities: { transfers: { requested: true } },
      metadata: { userId },
    });
    accountId = account.id;
    user.stripeConnectAccountId = accountId;
    await user.save();
  }

  const frontendUrl = (config.frontendUrl || config.corsOrigin || 'http://localhost:3000').split(',')[0].trim();
  const accountLink = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${frontendUrl}/driver/settings?stripe=refresh`,
    return_url: `${frontendUrl}/driver/settings?stripe=success`,
    type: 'account_onboarding',
  });

  res.json(new ApiResponse(200, { url: accountLink.url }, 'URL generated'));
});

const getMyPayouts = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const payouts = await DriverPayout.find({ driverId: userId })
    .populate('loadId', 'loadNumber pickupLocation deliveryLocation')
    .sort({ createdAt: -1 });
  res.json(new ApiResponse(200, payouts, 'Payouts fetched'));
});

const getDriverConnectStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const user = await User.findById(userId);
  if (!user?.stripeConnectAccountId) return res.json(new ApiResponse(200, { connected: false }, 'Not connected'));

  try {
    const account = await stripe.accounts.retrieve(user.stripeConnectAccountId);
    res.json(new ApiResponse(200, {
      connected: true, accountId: account.id, detailsSubmitted: account.details_submitted,
      chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled,
    }, 'Status retrieved'));
  } catch (err: any) {
    if (err?.code === 'resource_missing') {
      user.stripeConnectAccountId = undefined; await user.save();
      return res.json(new ApiResponse(200, { connected: false }, 'Account deleted'));
    }
    res.json(new ApiResponse(200, { connected: true, accountId: user.stripeConnectAccountId, error: 'Temporary error' }, 'Failed status check'));
  }
});

export default {
  getDeliverableLoads, getPendingProofs, getOrgAdmins, createPayout,
  getPayouts, getPayoutStats, getMyPayouts, initiateDriverOnboarding, getDriverConnectStatus,
};
