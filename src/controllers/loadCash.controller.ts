/**
 * COP/COD loads (SuprahPay, 2026-11-25): the customer hands the driver their
 * pay in cash, outside Suprah. The driver confirms it (that settles it) or
 * says they weren't paid (dispatch and the dealership's admins are told).
 * The customer confirms paying from My Shipments; it's recorded too.
 */
import { Request, Response } from 'express';
import mongoose from 'mongoose';
import Load from '../models/Load.model';
import User, { IUser } from '../models/User.model';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import { notifyOrgAdmins, safeCreateNotification } from '../utils/safeNotification';
import { carrierPayOf, cashDueNow } from '../utils/loadBilling';
import logger from '../utils/logger';

const CASH_LOAD_FIELDS = 'organizationId loadNumber status assignedDriverId dispatchOwnerId createdBy pricing billing pickupLocation.city deliveryLocation.city';

const cashLabel = (method: unknown) => (method === 'cop' ? 'cash at pickup (COP)' : 'cash on delivery (COD)');
const amountText = (pricing: any) => {
  const pay = carrierPayOf(pricing);
  return pay === null ? 'the driver\'s pay' : `$${pay.toFixed(2)}`;
};

/** What the driver's and the customer's screens show about a COP/COD load. */
function cashView(load: any) {
  return {
    loadId: String(load._id),
    loadNumber: load.loadNumber,
    method: load.billing?.method,
    // Hidden from the driver when the dealership hides the pay.
    amount: load.pricing?.isVisibleToDriver === false ? null : carrierPayOf(load.pricing),
    due: cashDueNow(load.billing?.method, load.status),
    driverConfirmedAt: load.billing?.cashConfirmedAt ?? null,
    driverNotPaidAt: load.billing?.cashNotReceivedAt ?? null,
    customerConfirmedAt: load.billing?.cashCustomerConfirmedAt ?? null,
    route: [load.pickupLocation?.city, load.deliveryLocation?.city].filter(Boolean).join(' → '),
    status: load.status,
  };
}

/**
 * POST /api/driver-tracking/loads/:id/cash  { received: boolean }
 * The driver of a COP/COD load confirms the cash, or says they weren't paid.
 */
export const confirmCashAsDriver = asyncHandler(async (req: Request, res: Response) => {
  const driver = req.user as IUser;
  if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'That load could not be found.');
  if (typeof req.body?.received !== 'boolean') throw new ApiError(400, 'Choose whether you received the cash.');
  const received: boolean = req.body.received;

  const load = await Load.findOne({ _id: req.params.id, assignedDriverId: driver._id }).select(CASH_LOAD_FIELDS).lean<any>();
  if (!load) throw new ApiError(404, 'That load could not be found among your loads.');
  if (load.billing?.method !== 'cop' && load.billing?.method !== 'cod') {
    throw new ApiError(400, 'This load is paid through SuprahPay, not in cash.');
  }
  if (!cashDueNow(load.billing.method, load.status)) {
    throw new ApiError(400, load.billing.method === 'cop' ? 'Confirm the cash once the car is picked up.' : 'Confirm the cash once the car is delivered.');
  }
  if (load.billing.cashConfirmedAt) {
    return res.json(new ApiResponse(200, cashView(load), 'The cash was already confirmed.'));
  }

  const now = new Date();
  const updated = await Load.findOneAndUpdate(
    { _id: load._id, assignedDriverId: driver._id, 'billing.cashConfirmedAt': null },
    received
      ? { $set: { 'billing.cashConfirmedAt': now }, $unset: { 'billing.cashNotReceivedAt': '' } }
      : { $set: { 'billing.cashNotReceivedAt': now } },
    { new: true, timestamps: false },
  ).select(CASH_LOAD_FIELDS).lean<any>();
  if (!updated) throw new ApiError(409, 'The cash for this load was confirmed a moment ago. Refresh the load.');

  if (!received) {
    // Told once per report; the driver can still confirm the cash later.
    const message = `${driver.name || 'The driver'} says they weren't paid the ${cashLabel(load.billing.method)} of ${amountText(load.pricing)} for load ${load.loadNumber}. Contact the customer to sort it out.`;
    const route = '/transportation?tab=shipments';
    if (load.dispatchOwnerId) {
      void safeCreateNotification({
        userId: String(load.dispatchOwnerId),
        organizationId: String(load.organizationId),
        type: 'general',
        title: 'Driver not paid in cash',
        message,
        metadata: { loadId: String(load._id), route },
      });
    }
    void notifyOrgAdmins(String(load.organizationId), 'general', 'Driver not paid in cash', message, { loadId: String(load._id), route });
    logger.info({ loadId: String(load._id) }, 'Driver reported the COP/COD cash as not received');
  }
  res.json(new ApiResponse(200, cashView(updated), received ? 'Thanks, the cash is confirmed.' : 'Your dispatcher and the dealership were told.'));
});

/** The signed-in customer's verified email, or null. */
async function customerEmail(req: Request): Promise<string | null> {
  const account = await User.findById((req.user as IUser)?._id).select('email emailVerified isActive role').lean<any>();
  if (!account?.email || !account.emailVerified || account.isActive === false) return null;
  return String(account.email).toLowerCase();
}

/**
 * GET /api/quote-requests/cash-payments
 * The customer's COP/COD loads (from a quote or not), for My Shipments.
 */
export const listCustomerCashLoads = asyncHandler(async (req: Request, res: Response) => {
  const email = await customerEmail(req);
  if (!email) return res.json(new ApiResponse(200, [], 'No cash payments'));
  const loads = await Load.find({
    'billing.customerEmail': email,
    'billing.method': { $in: ['cop', 'cod'] },
    status: { $ne: 'Cancelled' },
  })
    .select(CASH_LOAD_FIELDS)
    .sort({ createdAt: -1 })
    .limit(50)
    .lean<any[]>();
  // The customer always sees what they owe the driver.
  res.json(new ApiResponse(200, loads.map((load) => ({ ...cashView(load), amount: carrierPayOf(load.pricing) })), 'Cash payments'));
});

/**
 * POST /api/quote-requests/cash-payments/:loadId
 * The customer confirms they paid the driver in cash.
 */
export const confirmCashAsCustomer = asyncHandler(async (req: Request, res: Response) => {
  const email = await customerEmail(req);
  if (!email) throw new ApiError(403, 'Verify your email first, then confirm the payment.');
  if (!mongoose.isValidObjectId(req.params.loadId)) throw new ApiError(404, 'That shipment could not be found.');
  const load = await Load.findOne({ _id: req.params.loadId, 'billing.customerEmail': email, 'billing.method': { $in: ['cop', 'cod'] } })
    .select(CASH_LOAD_FIELDS)
    .lean<any>();
  if (!load) throw new ApiError(404, 'That shipment could not be found.');
  if (!cashDueNow(load.billing.method, load.status)) {
    throw new ApiError(400, load.billing.method === 'cop' ? 'Confirm this once the driver picks up the car.' : 'Confirm this once the car is delivered.');
  }
  const updated = await Load.findOneAndUpdate(
    { _id: load._id, 'billing.cashCustomerConfirmedAt': null },
    { $set: { 'billing.cashCustomerConfirmedAt': new Date() } },
    { new: true, timestamps: false },
  ).select(CASH_LOAD_FIELDS).lean<any>();
  const current = updated ?? load;
  res.json(new ApiResponse(200, { ...cashView(current), amount: carrierPayOf(current.pricing) }, 'Thanks, your payment is noted.'));
});
