import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import Organization from '../models/Organization.model';
import { suprahPayOn } from '../services/suprahPaySettings.service';
import {
  checkSendingPayout,
  owedByDealership,
  payoutAccountFor,
  payoutAccountLink,
  recentPayouts,
  sendDealershipPayout,
  weekStartUtah,
} from '../services/dealershipPayouts.service';
import { isDealershipAdmin } from './suprahPaySettings.controller';

/**
 * Suprah's weekly payouts to dealerships (2026-11-21). Dealership routes sit
 * behind the payments router's staff check (connecting needs a dealership
 * admin); super admin routes behind the admin router's super-admin check.
 */

const orgIdOf = (req: Request) => {
  const orgId = req.orgId;
  if (!orgId || !mongoose.isValidObjectId(orgId)) throw new ApiError(400, 'Choose a dealership first.');
  return orgId;
};

/* ─────────────────────────── Dealerships ────────────────────────────────── */

/** GET /api/payments/payout-account: is the dealership's Stripe payout account set up? */
export const getDealershipPayoutAccount = asyncHandler(async (req: Request, res: Response) => {
  res.json(new ApiResponse(200, await payoutAccountFor(orgIdOf(req)), 'Payout account'));
});

/** POST /api/payments/payout-account/connect (dealership admins): a Stripe setup link. */
export const connectDealershipPayoutAccount = asyncHandler(async (req: Request, res: Response) => {
  if (!isDealershipAdmin(req)) throw new ApiError(403, "Only your dealership's admins can set up the payout account.");
  const url = await payoutAccountLink(orgIdOf(req), req.user?.email);
  res.json(new ApiResponse(200, { url }, 'Payout account setup link'));
});

/**
 * GET /api/payments/payouts: what Suprah owes the dealership now, what next
 * week's payout covers so far, and its payout history.
 */
export const getDealershipPayouts = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgIdOf(req);
  const org = await Organization.findById(orgId).select('suprahPay.payoutsStartAt suprahPay.stripeAccountId').lean();
  if (!org) throw new ApiError(404, "Your dealership couldn't be found.");

  const cutoff = weekStartUtah(new Date());
  const starts = [{ _id: orgId, payoutsStartAt: org.suprahPay?.payoutsStartAt }];
  const [dueNow, everything, history] = await Promise.all([
    owedByDealership(starts, cutoff),
    owedByDealership(starts, new Date()),
    recentPayouts({ organizationId: String(orgId) }, 20),
  ]);
  const summary = (owed?: { amount: number; paymentCount: number; heldCount: number }) => ({
    amount: owed?.amount ?? 0,
    paymentCount: owed?.paymentCount ?? 0,
    heldCount: owed?.heldCount ?? 0,
  });

  res.json(new ApiResponse(200, {
    payoutAccountConnected: !!org.suprahPay?.stripeAccountId,
    payoutsStartAt: org.suprahPay?.payoutsStartAt ?? null,
    /** Everything Suprah owes the dealership right now. */
    balance: summary(everything.get(String(orgId))),
    /** Paid before this Monday (Utah time): goes in this week's payout once approved. */
    thisWeek: { ...summary(dueNow.get(String(orgId))), cutoff },
    history: history.map((p) => ({
      _id: String(p._id),
      amount: p.amount,
      paymentsTotal: p.paymentsTotal,
      suprahFee: p.suprahFee,
      adjustments: p.adjustments ?? 0,
      paymentCount: p.paymentCount,
      status: p.status,
      cutoff: p.cutoff,
      sentAt: p.sentAt ?? null,
      createdAt: p.createdAt,
    })),
  }, 'Payouts'));
});

/* ─────────────────────────── Super admins ───────────────────────────────── */

/**
 * GET /api/admin/suprahpay/payouts: this week's list, one row per dealership
 * with SuprahPay on or a payout account, and the latest payouts.
 */
export const listPayoutsForAdmin = asyncHandler(async (_req: Request, res: Response) => {
  const orgs = await Organization.find({ status: { $ne: 'archived' } })
    .select('name subscription.tier suprahPay')
    .sort({ name: 1 })
    .limit(1000)
    .lean();
  const relevant = orgs.filter((org) => suprahPayOn(org) || org.suprahPay?.stripeAccountId);
  const cutoff = weekStartUtah(new Date());
  const [owed, history] = await Promise.all([
    owedByDealership(relevant.map((org) => ({ _id: org._id, payoutsStartAt: org.suprahPay?.payoutsStartAt })), cutoff),
    recentPayouts({}, 50),
  ]);

  res.json(new ApiResponse(200, {
    cutoff,
    dealerships: relevant.map((org) => {
      const row = owed.get(String(org._id));
      return {
        _id: String(org._id),
        name: org.name,
        suprahPayOn: suprahPayOn(org),
        payoutAccountConnected: !!org.suprahPay?.stripeAccountId,
        sending: !!org.suprahPay?.payoutClaimedAt,
        amount: row?.amount ?? 0,
        paymentsTotal: row?.paymentsTotal ?? 0,
        suprahFee: row?.suprahFee ?? 0,
        adjustments: row?.adjustments ?? 0,
        paymentCount: row?.paymentCount ?? 0,
        heldCount: row?.heldCount ?? 0,
      };
    }),
    history: history.map((p) => ({
      _id: String(p._id),
      organizationId: p.organizationId,
      organizationName: p.organizationName,
      amount: p.amount,
      paymentCount: p.paymentCount,
      status: p.status,
      failureReason: p.failureReason ?? null,
      cutoff: p.cutoff,
      sentAt: p.sentAt ?? null,
      createdAt: p.createdAt,
    })),
  }, 'Dealership payouts'));
});

/** POST /api/admin/suprahpay/payouts/:orgId/send  { amount } — the amount the super admin reviewed. */
export const sendPayoutForAdmin = asyncHandler(async (req: Request, res: Response) => {
  const payout = await sendDealershipPayout(req.params.orgId, req.body?.amount, String(req.user?._id));
  res.json(new ApiResponse(200, payout, 'Payout sent'));
});

/** POST /api/admin/suprahpay/payouts/record/:payoutId/check — a payout Stripe didn't confirm. */
export const checkPayoutForAdmin = asyncHandler(async (req: Request, res: Response) => {
  const payout = await checkSendingPayout(req.params.payoutId, String(req.user?._id));
  res.json(new ApiResponse(200, payout, 'Payout confirmed'));
});

