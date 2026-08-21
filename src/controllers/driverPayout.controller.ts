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
import { getSignedProofUrl } from '../utils/signedUrlCache';

const stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: "2026-02-25.clover",
});

const getUserId = (req: Request): string => {
  const userId = (req.user as IUser)?._id?.toString();
  if (!userId) throw new ApiError(401, "User not authenticated");
  return userId;
};

const getDeliverableLoads = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;

  const deliverableFilter = {
    organizationId: orgId,
    assignedDriverId: { $exists: true, $ne: null },
    $or: [
      { status: "Delivered" },
      {
        "proofOfDelivery.imageUrl": { $exists: true, $ne: "" },
        "proofOfDelivery.confirmedAt": { $exists: true },
      },
    ],
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

  const result = await Promise.all(
    allItems.map(async (s) => {
      let item: any = {
        ...s,
        existingPayout: payoutByEntity[s._id.toString()] || null,
        pendingConfirmation: !!(s.proofOfDelivery?.imageUrl && !s.proofOfDelivery?.confirmedAt),
      };
      if (item.proofOfDelivery?.imageUrl) {
        const signed = await getSignedProofUrl(item.proofOfDelivery.imageUrl);
        if (signed) item = { ...item, proofOfDelivery: { ...item.proofOfDelivery, imageUrl: signed } };
      }
      return item;
    })
  );

  res.json(new ApiResponse(200, result, 'Deliverable loads fetched successfully'));
});

/**
 * GET /driver-payouts/pending-proofs
 * Returns Loads where proof was submitted to this specific admin and not yet confirmed.
 */
const getPendingProofs = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const role = (req.user as IUser)?.role;

  const canViewAllPendingProofs = role && role !== "driver";

  const proofFilter: Record<string, any> = {
    organizationId: orgId,
    "proofOfDelivery.imageUrl": { $exists: true, $ne: "" },
    "proofOfDelivery.confirmedAt": { $exists: false },
  };

  if (!canViewAllPendingProofs) {
    proofFilter["proofOfDelivery.submittedTo"] = userId;
  }

  const loads = await Load.find(proofFilter)
    .populate('assignedDriverId', 'name email')
    .sort({ 'proofOfDelivery.submittedAt': -1 })
    .lean();

  const signUrl = async (item: any): Promise<any> => {
    if (item.proofOfDelivery?.imageUrl) {
      const signed = await getSignedProofUrl(item.proofOfDelivery.imageUrl);
      if (signed) return { ...item, proofOfDelivery: { ...item.proofOfDelivery, imageUrl: signed } };
    }
    return item;
  };

  const normalizedLoads = loads.map((l: any) => ({
    ...l,
    _type: "load",
    trackingNumber: l.loadNumber,
    origin: l.pickupLocation
      ? `${l.pickupLocation.city}, ${l.pickupLocation.state}`
      : undefined,
    destination: l.deliveryLocation
      ? `${l.deliveryLocation.city}, ${l.deliveryLocation.state}`
      : undefined,
  }));

  const combined = await Promise.all(
    normalizedLoads
      .sort((a: any, b: any) => new Date(b.proofOfDelivery?.submittedAt).getTime() - new Date(a.proofOfDelivery?.submittedAt).getTime())
      .map(signUrl)
  );

  res.json(
    new ApiResponse(200, combined, "Pending proofs fetched successfully"),
  );
});

/**
 * GET /driver-payouts/org-admins
 */
const getOrgAdmins = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const admins = await User.find({
    organizationId: orgId,
    role: { $in: ["admin", "super_admin", "employee"] },
    isActive: true,
  })
    .select("_id name email role")
    .lean();
  res.json(new ApiResponse(200, admins, "Org admins fetched"));
});

/**
 * POST /driver-payouts
 */
const createPayout = asyncHandler(async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const orgId = req.orgId as string;
  const { loadId, driverId, amount, description, notes } = req.body;

  if (!loadId || !driverId || amount === undefined || amount === null) {
    throw new ApiError(400, 'loadId, driverId, and amount are required');
  }

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new ApiError(400, 'Amount must be a positive number');
  }

  const load = await Load.findOne({ _id: loadId, organizationId: orgId, status: 'Delivered' });
  if (!load) throw new ApiError(404, 'Load not found or not delivered');

  if (!load.assignedDriverId || load.assignedDriverId.toString() !== driverId) {
    throw new ApiError(400, 'driverId must be the driver assigned to this load');
  }

  const duplicate = await DriverPayout.findOne({ organizationId: orgId, loadId, status: { $in: ['paid', 'processing'] } });
  if (duplicate) throw new ApiError(400, 'Payout already processing or paid for this load');

  // Drivers are a shared platform-wide pool — payable by any org that had them on a load.
  const driver = await User.findOne({ _id: driverId, role: 'driver' });
  if (!driver) throw new ApiError(404, 'Driver not found');
  if (!driver.stripeConnectAccountId) throw new ApiError(400, 'Driver has no Stripe Connect account');

  const payout = await DriverPayout.create({
    organizationId: orgId,
    loadId,
    driverId,
    driverName: driver.name,
    driverEmail: driver.email,
    amount: numericAmount,
    currency: 'usd',
    description: description || `Payout for load ${load.loadNumber}`,
    status: 'processing',
    notes,
    createdBy: userId,
  });

  try {
    const transfer = await stripe.transfers.create({
      amount: Math.round(numericAmount * 100),
      currency: "usd",
      destination: driver.stripeConnectAccountId,
      description: payout.description,
      metadata: { payoutId: payout._id.toString(), loadId: loadId.toString() },
    });

    payout.stripeTransferId = transfer.id;
    payout.status = "paid";
    payout.paidAt = new Date();
    await payout.save();

    safeCreateNotification({
      userId: driverId,
      organizationId: orgId,
      type: 'driver_payout',
      title: 'Payout Received',
      message: `You received a payout of $${numericAmount.toFixed(2)} for load ${load.loadNumber}`,
      metadata: { loadId, amount: numericAmount },
    });

    await activityService.logFinancialActivity(driverId, orgId, 'payout_received', numericAmount, `Received payout for load ${load.loadNumber}`, { loadId: load._id.toString(), payoutId: payout._id.toString() });

    logger.info(
      { payoutId: payout._id, driverId, amount: numericAmount },
      "Driver payout sent successfully",
    );

    res.status(201).json(new ApiResponse(201, payout, 'Payout sent successfully'));
  } catch (stripeError: any) {
    payout.status = "failed";
    payout.failureReason = stripeError?.message || "Stripe transfer failed";
    await payout.save();
    throw new ApiError(402, `Payout failed: ${payout.failureReason}`);
  }
});

const VALID_PAYOUT_STATUSES = ["pending", "processing", "paid", "failed"] as const;

const getPayouts = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { status, driverId } = req.query;
  const isReportRequest = req.query.report === 'true';

  if (status && status !== 'all' && !VALID_PAYOUT_STATUSES.includes(status as any)) {
    throw new ApiError(400, `Invalid status filter. Must be one of: all, ${VALID_PAYOUT_STATUSES.join(', ')}`);
  }

  const filter: Record<string, any> = { organizationId: orgId };
  if (status && status !== 'all') filter.status = status;
  if (driverId) filter.driverId = driverId;

  const dateParam = (req.query.date as string | undefined)?.trim();
  const dateMatch = dateParam?.match(/^(\d{4})-(\d{2})$/);
  const year = Number(req.query.year ?? dateMatch?.[1]);
  const month = Number(req.query.month ?? dateMatch?.[2]);

  if (Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12) {
    filter.createdAt = {
      $gte: new Date(Date.UTC(year, month - 1, 1)),
      $lt: new Date(Date.UTC(year, month, 1)),
    };
  }

  const requestedLimit = parseInt(req.query.limit as string) || (isReportRequest ? 5000 : 200);
  const limit = Math.min(isReportRequest ? 5000 : 500, Math.max(1, requestedLimit));
  const skip = Math.max(0, parseInt(req.query.skip as string) || 0);

  const [payouts, total, summaryRows] = await Promise.all([
    DriverPayout.find(filter)
      .populate('driverId', 'name email avatar phone')
      .populate(
        'loadId',
        'loadNumber status pricing pickupLocation deliveryLocation vehicles deliveredAt createdAt',
      )
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    DriverPayout.countDocuments(filter),
    DriverPayout.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalPayouts: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
          totalPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, '$amount', 0] } },
          totalPending: {
            $sum: { $cond: [{ $in: ['$status', ['pending', 'processing']] }, '$amount', 0] },
          },
          countPaid: { $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] } },
          countPending: {
            $sum: { $cond: [{ $in: ['$status', ['pending', 'processing']] }, 1, 0] },
          },
          countFailed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
          uniqueDrivers: { $addToSet: '$driverId' },
        },
      },
    ]),
  ]);

  const aggregate = summaryRows[0] ?? {};
  const totalPayouts = aggregate.totalPayouts ?? 0;
  const summary = {
    totalPayouts,
    totalDrivers: aggregate.uniqueDrivers?.length ?? 0,
    totalAmount: aggregate.totalAmount ?? 0,
    totalPaid: aggregate.totalPaid ?? 0,
    totalPending: aggregate.totalPending ?? 0,
    countPaid: aggregate.countPaid ?? 0,
    countPending: aggregate.countPending ?? 0,
    countFailed: aggregate.countFailed ?? 0,
    averagePayout: totalPayouts ? (aggregate.totalAmount ?? 0) / totalPayouts : 0,
  };

  // Preserve the legacy array response for existing payout screens.
  // Reports receive a richer paginated object only when report=true.
  if (!isReportRequest) {
    return res.json(new ApiResponse(200, payouts, 'Payouts fetched successfully'));
  }

  return res.json(
    new ApiResponse(
      200,
      { payouts, total, summary, page: Math.floor(skip / limit) + 1, limit },
      'Report payouts fetched successfully',
    ),
  );
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