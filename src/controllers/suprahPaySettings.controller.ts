import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import Organization from '../models/Organization.model';
import AuditLog from '../models/AuditLog.model';
import activityService from '../services/activity.service';
import { notifyOrgAdmins } from '../utils/safeNotification';
import logger from '../utils/logger';
import { hasFinanceAccess } from '../utils/financeAccess';
import {
  STRIPE_MAX_PAYMENT,
  dealershipTaxRate,
  getPlatformSettings,
  platformSettingsChange,
  savePlatformSettings,
  suprahPayOn,
  taxRateSetting,
} from '../services/suprahPaySettings.service';

/**
 * SuprahPay settings (2026-11-21). Super admin routes sit behind the admin
 * router's super-admin check; dealership routes behind the payments router's
 * staff check, and changes need a dealership admin.
 */

const userIdOf = (req: Request) => (req.user?._id ? String(req.user._id) : undefined);

/** A dealership admin, or a super admin working in a dealership. */
export function isDealershipAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === 'super_admin' || role === 'admin' || req.orgRole === 'admin';
}

/** Best-effort audit entry: the change has happened even if this fails. */
async function audit(entry: Record<string, unknown>) {
  try {
    await AuditLog.create(entry);
  } catch (error) {
    logger.warn({ err: (error as Error)?.message }, 'SuprahPay settings audit entry failed');
  }
}

/* ─────────────────────────── Super admins ───────────────────────────────── */

/** GET /api/admin/suprahpay/settings */
export const getPlatformSettingsForAdmin = asyncHandler(async (_req: Request, res: Response) => {
  const settings = await getPlatformSettings();
  res.json(new ApiResponse(200, { ...settings, stripeMaxPayment: STRIPE_MAX_PAYMENT }, 'SuprahPay settings'));
});

/** PUT /api/admin/suprahpay/settings  { feePercent?, maxPaymentAmount? } */
export const updatePlatformSettingsForAdmin = asyncHandler(async (req: Request, res: Response) => {
  const checked = platformSettingsChange(req.body);
  if (!checked.ok) throw new ApiError(400, checked.message);

  const before = await getPlatformSettings();
  const after = await savePlatformSettings(checked.change);

  await audit({
    entityType: 'System',
    entityId: 'suprahpay',
    action: 'UPDATE',
    reason: 'SuprahPay settings changed',
    performedBy: userIdOf(req),
    changes: { before, after },
  });
  logger.info({ change: checked.change }, 'SuprahPay settings changed');
  res.json(new ApiResponse(200, { ...after, stripeMaxPayment: STRIPE_MAX_PAYMENT }, 'SuprahPay settings saved'));
});

/** GET /api/admin/suprahpay/dealerships: every active dealership and whether SuprahPay is on. */
export const listDealershipsForAdmin = asyncHandler(async (_req: Request, res: Response) => {
  const orgs = await Organization.find({ status: { $ne: 'archived' } })
    .select('name status subscription.tier suprahPay.enabled')
    .sort({ name: 1 })
    .limit(1000)
    .lean();

  const dealerships = orgs.map((org) => ({
    _id: String(org._id),
    name: org.name,
    status: org.status,
    tier: org.subscription?.tier ?? null,
    suprahPayOn: suprahPayOn(org),
    /** True when a super admin set the switch; false when it follows the plan. */
    switchSet: typeof org.suprahPay?.enabled === 'boolean',
  }));
  res.json(new ApiResponse(200, dealerships, 'Dealerships'));
});

/** PUT /api/admin/suprahpay/dealerships/:id  { enabled: boolean } */
export const setDealershipSuprahPayForAdmin = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, "That dealership couldn't be found.");
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') throw new ApiError(400, 'Choose whether SuprahPay is on or off.');

  const org = await Organization.findOneAndUpdate(
    { _id: id },
    {
      $set: {
        'suprahPay.enabled': enabled,
        'suprahPay.updatedAt': new Date(),
        'suprahPay.updatedBy': userIdOf(req),
      },
    },
    { new: true, projection: { name: 1, status: 1, 'subscription.tier': 1, suprahPay: 1 } },
  ).lean();
  if (!org) throw new ApiError(404, "That dealership couldn't be found.");

  await audit({
    entityType: 'Organization',
    entityId: String(org._id),
    organizationId: String(org._id),
    action: 'UPDATE',
    reason: enabled ? 'SuprahPay turned on' : 'SuprahPay turned off',
    performedBy: userIdOf(req),
    changes: { suprahPayEnabled: enabled },
  });
  notifyOrgAdmins(
    String(org._id),
    'admin_broadcast',
    enabled ? 'SuprahPay is on' : 'SuprahPay is paused',
    enabled
      ? 'Your dealership can now send payment requests and take card payments with SuprahPay.'
      : "SuprahPay is paused for your dealership. Payment requests can't be sent until Suprah turns it back on.",
    { route: '/billing' },
  );

  res.json(new ApiResponse(200, {
    _id: String(org._id),
    name: org.name,
    status: org.status,
    tier: org.subscription?.tier ?? null,
    suprahPayOn: suprahPayOn(org),
    switchSet: true,
  }, enabled ? 'SuprahPay turned on' : 'SuprahPay turned off'));
});

/* ─────────────────────────── Dealerships ────────────────────────────────── */

/** GET /api/payments/settings: what the dealership's SuprahPay screens need. */
export const getDealershipSettings = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId;
  if (!orgId || !mongoose.isValidObjectId(orgId)) throw new ApiError(400, 'Choose a dealership first.');

  const [org, platform] = await Promise.all([
    Organization.findById(orgId).select('subscription.tier suprahPay').lean(),
    getPlatformSettings(),
  ]);
  if (!org) throw new ApiError(404, "Your dealership couldn't be found.");

  res.json(new ApiResponse(200, {
    enabled: suprahPayOn(org),
    defaultTaxRate: dealershipTaxRate(org),
    maxPaymentAmount: platform.maxPaymentAmount,
    feePercent: platform.feePercent,
    canEdit: isDealershipAdmin(req),
    /** Can send payment requests and invoices, cancel and refund (Finance access). */
    canManagePayments: hasFinanceAccess(req.user as never, orgId, req.orgRole),
  }, 'SuprahPay settings'));
});

/** PUT /api/payments/settings  { defaultTaxRate } (dealership admins; the route checks too) */
export const updateDealershipSettings = asyncHandler(async (req: Request, res: Response) => {
  if (!isDealershipAdmin(req)) throw new ApiError(403, "Only your dealership's admins can change SuprahPay settings.");
  const orgId = req.orgId;
  if (!orgId || !mongoose.isValidObjectId(orgId)) throw new ApiError(400, 'Choose a dealership first.');

  const rate = taxRateSetting(req.body?.defaultTaxRate);
  if (rate === null) throw new ApiError(400, 'Enter the sales tax as a percentage from 0 to 100, for example 7.25.');

  const org = await Organization.findOneAndUpdate(
    { _id: orgId },
    {
      $set: {
        'suprahPay.defaultTaxRate': rate,
        'suprahPay.updatedAt': new Date(),
        'suprahPay.updatedBy': userIdOf(req),
      },
    },
    { new: true, projection: { 'subscription.tier': 1, suprahPay: 1 } },
  ).lean();
  if (!org) throw new ApiError(404, "Your dealership couldn't be found.");

  activityService
    .createActivity({
      userId: userIdOf(req) as string,
      organizationId: orgId,
      type: 'settings_change',
      title: 'SuprahPay settings changed',
      description: `Default sales tax set to ${rate}%`,
      metadata: { defaultTaxRate: rate },
    })
    .catch(() => undefined);

  const platform = await getPlatformSettings();
  res.json(new ApiResponse(200, {
    enabled: suprahPayOn(org),
    defaultTaxRate: dealershipTaxRate(org),
    maxPaymentAmount: platform.maxPaymentAmount,
    feePercent: platform.feePercent,
    canEdit: true,
    canManagePayments: true,
  }, 'SuprahPay settings saved'));
});
