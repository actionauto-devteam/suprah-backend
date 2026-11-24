import Stripe from 'stripe';
import mongoose from 'mongoose';
import config from '../config';
import Payment from '../models/Payment.model';
import Organization from '../models/Organization.model';
import DealershipPayout, { IDealershipPayout } from '../models/DealershipPayout.model';
import AuditLog from '../models/AuditLog.model';
import { ApiError } from '../utils/ApiError';
import logger from '../utils/logger';
import { notifyOrgAdmins, safeCreateNotification } from '../utils/safeNotification';
import User from '../models/User.model';
import { SUPPORT_EMAIL } from '../utils/userMessages';
import { payoutAccountStatus } from '../utils/driverPayoutAccount';
import {
  OwedSummary,
  PayoutPayment,
  owedFor,
  payoutAccountHold,
  payoutBankOf,
  payoutHoldMessage,
  weekStartUtah,
} from '../utils/dealershipPayouts';
import { getPlatformSettings } from './suprahPaySettings.service';
import { isStripeError, payoutSetupProblemMessage, stripeErrorForLog } from '../utils/stripeErrors';

/**
 * Suprah's weekly payouts to dealerships (2026-11-21, decision A4): each
 * dealership connects a Stripe payout account; every week a super admin
 * reviews what each dealership is owed and presses Send.
 *
 * Safety: only one payout per dealership at a time; the super admin's
 * reviewed amount must match; the payout is recorded before Stripe is asked,
 * so a stop half-way never lets the same money go twice; Stripe is told not
 * to repeat the transfer; an unclear answer from Stripe leaves the payout as
 * "sending" (never "failed") until it is checked.
 */

const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2026-02-25.clover' });

const cents = (n: number) => Math.round(n * 100) / 100;
const dollars = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
/** Stripe forgets a "don't repeat this" key after about a day. */
const SAFE_RETRY_MS = 20 * 60 * 60 * 1000;

const PAYOUT_PAYMENT_FIELDS = 'organizationId status amount refundedAmount disputeStatus disputedAmount suprahFeePercent paidAt';

/** What earlier payouts (sending or sent) covered for each payment. */
async function alreadySentByPayment(orgIds: string[]): Promise<Map<string, number>> {
  const rows: Array<{ _id: unknown; sent: number }> = await DealershipPayout.aggregate([
    { $match: { organizationId: { $in: orgIds }, status: { $in: ['sending', 'sent'] } } },
    { $unwind: '$allocations' },
    { $group: { _id: '$allocations.paymentId', sent: { $sum: '$allocations.amount' } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), cents(Number(row.sent) || 0)]));
}

/**
 * What each dealership is owed for payments paid before `cutoff` (and from
 * when it connected its payout account). Two database reads for all of them.
 */
export async function owedByDealership(
  orgs: Array<{ _id: unknown; payoutsStartAt?: Date | null }>,
  cutoff: Date,
): Promise<Map<string, OwedSummary>> {
  const started = orgs.filter((org) => org.payoutsStartAt instanceof Date || org.payoutsStartAt);
  const owed = new Map<string, OwedSummary>();
  if (!started.length) return owed;

  const orgIds = started.map((org) => String(org._id));
  const startOf = new Map(started.map((org) => [String(org._id), new Date(org.payoutsStartAt as Date)]));
  const [payments, alreadySent, platform] = await Promise.all([
    Payment.find({
      organizationId: { $in: orgIds },
      status: { $in: ['succeeded', 'refunded'] },
      paidAt: { $lt: cutoff },
    }).select(PAYOUT_PAYMENT_FIELDS).lean(),
    alreadySentByPayment(orgIds),
    getPlatformSettings(),
  ]);

  const byOrg = new Map<string, PayoutPayment[]>();
  for (const payment of payments as Array<PayoutPayment & { paidAt?: Date }>) {
    const orgId = String(payment.organizationId);
    const start = startOf.get(orgId);
    if (!start || !payment.paidAt || new Date(payment.paidAt) < start) continue;
    const list = byOrg.get(orgId) ?? [];
    list.push(payment);
    byOrg.set(orgId, list);
  }
  for (const orgId of orgIds) owed.set(orgId, owedFor(byOrg.get(orgId) ?? [], alreadySent, platform.feePercent));
  return owed;
}

/* ─────────────────────────── Payout account ─────────────────────────────── */

const isMissingAccount = (error: any) =>
  error?.code === 'resource_missing' || error?.code === 'account_invalid' || error?.type === 'StripePermissionError';

/** The dealership's payout account status (connected, ready, or what Stripe still needs). */
export async function payoutAccountFor(orgId: string) {
  const org = await Organization.findById(orgId)
    .select('suprahPay.stripeAccountId suprahPay.payoutsStartAt suprahPay.payoutConfirmedAccountId suprahPay.payoutBankChangedAt')
    .lean();
  const accountId = org?.suprahPay?.stripeAccountId;
  if (!accountId) return { connected: false as const };
  try {
    return {
      ...payoutAccountStatus(await stripe.accounts.retrieve(accountId)),
      payoutsStartAt: org?.suprahPay?.payoutsStartAt,
      // Payouts wait until a Suprah super admin confirms the account (2026-11-23).
      awaitingConfirmation: payoutAccountHold(org?.suprahPay) !== null,
    };
  } catch (error: any) {
    if (isMissingAccount(error)) {
      // The account isn't in this Stripe account any more (for example after a
      // move to a new Stripe account): set up again.
      await Organization.updateOne(
        { _id: orgId, 'suprahPay.stripeAccountId': accountId },
        { $unset: { 'suprahPay.stripeAccountId': '' } },
      );
      return { connected: false as const, needsReconnect: true };
    }
    logger.warn({ orgId, code: error?.code }, 'Could not check a dealership payout account');
    return { connected: true as const, error: "The payout account couldn't be checked just now. Try again in a moment." };
  }
}

/** Tells every Suprah super admin. A notice that fails never stops the action. */
async function notifySuperAdmins(title: string, message: string) {
  try {
    const superAdmins = await User.find({ role: 'super_admin' }).select('_id organizationId').lean();
    await Promise.all(superAdmins.map((admin) => safeCreateNotification({
      userId: String(admin._id),
      organizationId: admin.organizationId ? String(admin.organizationId) : 'global',
      type: 'admin_system_alert',
      title,
      message,
      metadata: { route: '/admin/suprahpay' },
    })));
  } catch {
    logger.warn('Super admins were not told about a payout account change');
  }
}

/**
 * Payout account safety (2026-11-23): when a payout account is set up or
 * replaced, the dealership's admins and Suprah's super admins are told, and
 * the dealership's payouts wait until a super admin confirms the account.
 */
function alertPayoutAccountSetUp(orgId: string, dealership: string, setUpBy: string, replaced: boolean) {
  void notifyOrgAdmins(
    orgId,
    'admin_broadcast',
    'SuprahPay payout account set up',
    `${setUpBy} started setting up your dealership's SuprahPay payout account. Suprah checks it before any payout goes to it. If this wasn't expected, contact Suprah AI support at ${SUPPORT_EMAIL}.`,
    { route: '/billing' },
  );
  void notifySuperAdmins(
    'Payout account needs confirming',
    replaced
      ? `${dealership} replaced its SuprahPay payout account. Its payouts are on hold until a super admin confirms the new one in Admin, SuprahPay.`
      : `${dealership} is setting up a SuprahPay payout account. Its payouts are on hold until a super admin confirms it in Admin, SuprahPay.`,
  );
}

function alertPayoutBankChanged(orgId: string, dealership: string) {
  void notifyOrgAdmins(
    orgId,
    'admin_broadcast',
    'SuprahPay payout bank details changed',
    `The bank details on your dealership's SuprahPay payout account changed in Stripe. Suprah holds your payouts until it confirms them with you. If this wasn't expected, contact Suprah AI support at ${SUPPORT_EMAIL}.`,
    { route: '/billing' },
  );
  void notifySuperAdmins(
    'Payout bank details changed',
    `${dealership}'s payout bank details changed in Stripe since they were confirmed. Its payouts are on hold until a super admin confirms them in Admin, SuprahPay.`,
  );
}

/** A Stripe setup link for the dealership's payout account, created on first use. */
export async function payoutAccountLink(
  orgId: string,
  admin: { email?: string; name?: string } = {},
): Promise<string> {
  const adminEmail = admin.email;
  const org = await Organization.findById(orgId).select('name suprahPay.stripeAccountId suprahPay.payoutConfirmedAccountId').lean();
  if (!org) throw new ApiError(404, "Your dealership couldn't be found.");

  // Stripe's refusal (for example, payout accounts not switched on in
  // Suprah's Stripe account) is logged by type and code; the dealership's
  // admin gets a plain message, never Stripe's developer text (2026-11-23).
  const refused = (error: unknown): never => {
    if (!isStripeError(error)) throw error;
    logger.warn({ orgId, ...stripeErrorForLog(error) }, 'Dealership payout account setup refused');
    throw new ApiError(502, payoutSetupProblemMessage(error));
  };

  let accountId = org.suprahPay?.stripeAccountId;
  if (!accountId) {
    const account = await stripe.accounts.create({
      type: 'express',
      country: 'US',
      business_type: 'company',
      ...(adminEmail ? { email: adminEmail } : {}),
      business_profile: { name: String(org.name || '').slice(0, 100) || undefined },
      capabilities: { transfers: { requested: true } },
      metadata: { organizationId: String(orgId) },
    }).catch(refused);
    // Saved only if no other admin connected one at the same moment. Payouts
    // count payments from the first time a payout account was connected; a
    // later reconnect keeps that date, so no payment is ever skipped.
    const saved = await Organization.findOneAndUpdate(
      { _id: orgId, $or: [{ 'suprahPay.stripeAccountId': { $exists: false } }, { 'suprahPay.stripeAccountId': null }] },
      [{
        $set: {
          'suprahPay.stripeAccountId': account.id,
          'suprahPay.payoutsStartAt': { $ifNull: ['$suprahPay.payoutsStartAt', '$$NOW'] },
          'suprahPay.payoutAccountSetAt': '$$NOW',
        },
      }],
      { new: true, projection: { 'suprahPay.stripeAccountId': 1 } },
    ).lean();
    if (saved?.suprahPay?.stripeAccountId === account.id) {
      alertPayoutAccountSetUp(
        String(orgId),
        String(org.name || 'A dealership'),
        admin.name?.trim() || 'One of your admins',
        !!org.suprahPay?.payoutConfirmedAccountId,
      );
    }
    accountId = saved?.suprahPay?.stripeAccountId
      ?? (await Organization.findById(orgId).select('suprahPay.stripeAccountId').lean())?.suprahPay?.stripeAccountId
      ?? account.id;
  }

  const site = String(config.frontendUrl || config.corsOrigin || 'http://localhost:3000').split(',')[0].trim();
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${site}/billing?payoutAccount=refresh`,
    return_url: `${site}/billing?payoutAccount=done`,
    type: 'account_onboarding',
  }).catch(refused);
  return link.url;
}

/* ─────────────────────────── Sending a payout ───────────────────────────── */

/** What Stripe's refusal means, for the super admin. */
function stripeRefusal(error: any): { definite: boolean; message: string } {
  if (error?.code === 'balance_insufficient') {
    return {
      definite: true,
      message: "Suprah's Stripe balance doesn't have enough available money for this payout yet. Card payments take a few days to become available; try again later.",
    };
  }
  const definite = ['StripeInvalidRequestError', 'StripePermissionError', 'StripeAuthenticationError', 'StripeCardError']
    .includes(String(error?.type));
  return {
    definite,
    message: definite
      // Stripe's own text stays off the screen; its type and code are logged.
      ? "The payout wasn't sent, so no money left Suprah's account. Check that the dealership's payout account is ready, then try again. If it keeps happening, ask the Suprah developers to check the payment logs."
      : "Stripe didn't confirm the payout. It stays marked as sending so it can't be sent twice; press Check again, or look in the Stripe dashboard.",
  };
}

async function transferFor(payout: IDealershipPayout) {
  return stripe.transfers.create(
    {
      amount: Math.round(payout.amount * 100),
      currency: 'usd',
      destination: payout.stripeAccountId,
      description: `SuprahPay payout to ${payout.organizationName || 'dealership'}`.slice(0, 350),
      metadata: { payoutId: String(payout._id), organizationId: payout.organizationId },
    },
    // Stripe never makes this transfer twice, even if asked again.
    { idempotencyKey: `dealership-payout-${String(payout._id)}` },
  );
}

async function markSent(payout: IDealershipPayout, transferId: string, approvedBy: string) {
  await DealershipPayout.updateOne(
    { _id: payout._id, status: 'sending' },
    { $set: { status: 'sent', stripeTransferId: transferId, sentAt: new Date() }, $unset: { failureReason: '' } },
  );
  notifyOrgAdmins(
    payout.organizationId,
    'admin_broadcast',
    'SuprahPay payout sent',
    `Suprah sent ${dollars(payout.amount)} to your payout account for ${payout.paymentCount} card payment${payout.paymentCount === 1 ? '' : 's'}. It usually reaches your bank in 2 business days.`,
    { route: '/billing' },
  );
  AuditLog.create({
    entityType: 'Billing',
    entityId: String(payout._id),
    organizationId: payout.organizationId,
    action: 'UPDATE',
    reason: 'SuprahPay payout sent to dealership',
    performedBy: approvedBy,
    changes: { amount: payout.amount, stripeTransferId: transferId },
  }).catch(() => undefined);
}

/** The dealership's Stripe payout account, or a plain reason it can't be read. */
async function retrievePayoutAccount(accountId: string): Promise<Stripe.Account> {
  try {
    return await stripe.accounts.retrieve(accountId);
  } catch (error: any) {
    throw new ApiError(409, isMissingAccount(error)
      ? "This dealership's payout account isn't in Suprah's Stripe account. Ask them to connect it again."
      : "Stripe couldn't be reached to check the payout account. Try again in a moment.");
  }
}

async function dealershipWithPayoutAccount(orgId: string) {
  if (!mongoose.isValidObjectId(orgId)) throw new ApiError(400, "That dealership couldn't be found.");
  const org = await Organization.findById(orgId).select('name suprahPay').lean();
  if (!org) throw new ApiError(404, "That dealership couldn't be found.");
  const accountId = org.suprahPay?.stripeAccountId;
  if (!accountId) throw new ApiError(409, "This dealership hasn't connected a Stripe payout account yet.");
  return { org, accountId, account: await retrievePayoutAccount(accountId) };
}

/**
 * What a super admin checks before confirming a payout account (2026-11-23):
 * whether it's ready, the business name and the bank it pays out to.
 */
export async function payoutAccountForAdmin(orgId: string) {
  const { org, account } = await dealershipWithPayoutAccount(orgId);
  const status = payoutAccountStatus(account);
  const bank = payoutBankOf(account);
  const confirmedBank = org.suprahPay?.payoutConfirmedBankId;
  return {
    ready: status.ready,
    needsMoreInfo: status.needsMoreInfo,
    businessName: account.business_profile?.name ?? account.company?.name ?? null,
    bank,
    hold: payoutAccountHold(org.suprahPay) ?? (confirmedBank && bank && bank.id !== confirmedBank ? 'bank_changed' : null),
    setAt: org.suprahPay?.payoutAccountSetAt ?? null,
    confirmedAt: org.suprahPay?.payoutConfirmedAt ?? null,
  };
}

/**
 * A super admin confirms the payout account they checked (2026-11-23): the
 * bank they saw must still be the one in Stripe. Payouts can then go to it;
 * the dealership's admins are told, and it's recorded.
 */
export async function confirmPayoutAccount(orgId: string, bankIdSeen: unknown, confirmedBy: string) {
  if (bankIdSeen !== undefined && bankIdSeen !== null && typeof bankIdSeen !== 'string') {
    throw new ApiError(400, 'Open the payout account again and confirm what you see.');
  }
  const { org, accountId, account } = await dealershipWithPayoutAccount(orgId);
  if (!payoutAccountStatus(account).ready) {
    throw new ApiError(409, "This dealership's payout account isn't ready yet: Stripe needs more details or is still checking them. Confirm it once it's ready.");
  }
  const bank = payoutBankOf(account);
  if ((bankIdSeen ?? null) !== (bank?.id ?? null)) {
    throw new ApiError(409, 'The bank details changed since you opened this. Close it and check them again.');
  }

  const confirmed = await Organization.findOneAndUpdate(
    { _id: orgId, 'suprahPay.stripeAccountId': accountId },
    {
      $set: {
        'suprahPay.payoutConfirmedAccountId': accountId,
        'suprahPay.payoutConfirmedBankId': bank?.id ?? null,
        'suprahPay.payoutConfirmedAt': new Date(),
        'suprahPay.payoutConfirmedBy': confirmedBy,
      },
      $unset: { 'suprahPay.payoutBankChangedAt': '' },
    },
    { new: true, projection: { _id: 1 } },
  ).lean();
  if (!confirmed) throw new ApiError(409, "This dealership's payout account changed a moment ago. Refresh and check it again.");

  AuditLog.create({
    entityType: 'Billing',
    entityId: String(orgId),
    organizationId: String(orgId),
    action: 'UPDATE',
    reason: 'SuprahPay payout account confirmed',
    performedBy: confirmedBy,
    changes: { bankLast4: bank?.last4 ?? null },
  }).catch(() => undefined);
  void notifyOrgAdmins(
    String(orgId),
    'admin_broadcast',
    'SuprahPay payout account confirmed',
    `Suprah confirmed your dealership's SuprahPay payout account${bank?.last4 ? ` (bank account ending in ${bank.last4})` : ''}. Weekly payouts go to it from now on. If you don't recognize it, contact Suprah AI support at ${SUPPORT_EMAIL}.`,
    { route: '/billing' },
  );
  logger.info({ orgId: String(orgId) }, 'Dealership payout account confirmed');
  return { confirmed: true as const, dealership: org.name, bankLast4: bank?.last4 ?? null };
}

/**
 * Sends a dealership what it's owed for this week (super admins). The amount
 * the super admin reviewed must still be right.
 */
export async function sendDealershipPayout(orgId: string, expectedAmount: unknown, approvedBy: string) {
  if (!mongoose.isValidObjectId(orgId)) throw new ApiError(400, "That dealership couldn't be found.");
  const expected = typeof expectedAmount === 'number' ? expectedAmount : Number(expectedAmount);
  if (!Number.isFinite(expected) || expected <= 0) throw new ApiError(400, 'Send the amount you reviewed.');

  const org = await Organization.findById(orgId).select('name suprahPay').lean();
  if (!org) throw new ApiError(404, "That dealership couldn't be found.");
  const accountId = org.suprahPay?.stripeAccountId;
  if (!accountId) throw new ApiError(409, "This dealership hasn't connected a Stripe payout account yet.");

  const account = await retrievePayoutAccount(accountId);
  if (!payoutAccountStatus(account).ready) throw new ApiError(409, "This dealership's Stripe payout account isn't ready yet: Stripe needs more details or is still checking them.");

  // Payout account safety (2026-11-23): only to an account a super admin
  // confirmed, with the bank details that were confirmed.
  const hold = payoutAccountHold(org.suprahPay);
  if (hold) throw new ApiError(409, payoutHoldMessage(hold));
  const bank = payoutBankOf(account);
  const confirmedBank = org.suprahPay?.payoutConfirmedBankId;
  if (confirmedBank && bank && bank.id !== confirmedBank) {
    const flagged = await Organization.updateOne(
      { _id: orgId, 'suprahPay.payoutConfirmedBankId': confirmedBank, 'suprahPay.payoutBankChangedAt': null },
      { $set: { 'suprahPay.payoutBankChangedAt': new Date() } },
    );
    if (flagged.modifiedCount) alertPayoutBankChanged(String(orgId), String(org.name || 'A dealership'));
    throw new ApiError(409, payoutHoldMessage('bank_changed'));
  }

  // One payout at a time for this dealership (a stuck claim expires after 10 minutes).
  const claimed = await Organization.findOneAndUpdate(
    {
      _id: orgId,
      $or: [
        { 'suprahPay.payoutClaimedAt': null },
        { 'suprahPay.payoutClaimedAt': { $lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) } },
      ],
    },
    { $set: { 'suprahPay.payoutClaimedAt': new Date() } },
    { new: true, projection: { _id: 1 } },
  ).lean();
  if (!claimed) throw new ApiError(409, 'A payout for this dealership is already being sent. Refresh in a moment.');

  try {
    const cutoff = weekStartUtah(new Date());
    const owed = (await owedByDealership([{ _id: orgId, payoutsStartAt: org.suprahPay?.payoutsStartAt }], cutoff)).get(String(orgId));
    if (!owed || owed.amount <= 0) throw new ApiError(409, 'There is nothing to send to this dealership this week.');
    if (cents(owed.amount) !== cents(expected)) {
      throw new ApiError(409, `The amount changed since the list was opened: it is now ${dollars(owed.amount)}. Refresh and check it again.`);
    }

    // Recorded before Stripe is asked: from here on this money counts as sent.
    const payout = await DealershipPayout.create({
      organizationId: String(orgId),
      organizationName: String(org.name || ''),
      cutoff,
      amount: owed.amount,
      paymentsTotal: owed.paymentsTotal,
      suprahFee: owed.suprahFee,
      adjustments: owed.adjustments,
      paymentCount: owed.paymentCount,
      allocations: owed.allocations.map((a) => ({ paymentId: new mongoose.Types.ObjectId(a.paymentId), amount: a.amount })),
      status: 'sending',
      stripeAccountId: accountId,
      approvedBy,
    });

    let transfer: Stripe.Transfer;
    try {
      transfer = await transferFor(payout);
    } catch (error: any) {
      const refusal = stripeRefusal(error);
      if (refusal.definite) {
        await DealershipPayout.updateOne({ _id: payout._id, status: 'sending' }, { $set: { status: 'failed', failureReason: refusal.message } });
      } else {
        await DealershipPayout.updateOne({ _id: payout._id }, { $set: { failureReason: refusal.message } });
      }
      logger.warn({ payoutId: payout._id, orgId, code: error?.code, type: error?.type }, 'Dealership payout not sent');
      throw new ApiError(402, refusal.message);
    }

    await markSent(payout, transfer.id, approvedBy);
    logger.info({ payoutId: payout._id, orgId, amount: payout.amount }, 'Dealership payout sent');
    return DealershipPayout.findById(payout._id).select('-allocations').lean();
  } finally {
    await Organization.updateOne({ _id: orgId }, { $set: { 'suprahPay.payoutClaimedAt': null } }).catch(() => undefined);
  }
}

/**
 * Checks a payout Stripe didn't confirm (super admins): asks Stripe again with
 * the same "don't repeat" key, so it is either confirmed or refused, never
 * sent twice. Only within a day, while Stripe still remembers the key.
 */
export async function checkSendingPayout(payoutId: string, approvedBy: string) {
  if (!mongoose.isValidObjectId(payoutId)) throw new ApiError(400, "That payout couldn't be found.");
  const payout = await DealershipPayout.findById(payoutId);
  if (!payout) throw new ApiError(404, "That payout couldn't be found.");
  if (payout.status !== 'sending') throw new ApiError(409, 'Only a payout that is still sending can be checked.');
  if (Date.now() - payout.createdAt.getTime() > SAFE_RETRY_MS) {
    throw new ApiError(409, 'This payout is too old to check here safely. Look for it in the Stripe dashboard and tell the Suprah team what you find before sending anything else.');
  }
  try {
    const transfer = await transferFor(payout);
    await markSent(payout, transfer.id, approvedBy);
  } catch (error: any) {
    const refusal = stripeRefusal(error);
    if (refusal.definite) {
      await DealershipPayout.updateOne({ _id: payout._id, status: 'sending' }, { $set: { status: 'failed', failureReason: refusal.message } });
    }
    throw new ApiError(402, refusal.message);
  }
  return DealershipPayout.findById(payout._id).select('-allocations').lean();
}

/** The latest payouts, without which payments they covered. */
export function recentPayouts(filter: Record<string, unknown>, limit: number) {
  return DealershipPayout.find(filter)
    .select('-allocations -stripeAccountId')
    .sort({ createdAt: -1 })
    .limit(Math.min(200, Math.max(1, limit)))
    .lean();
}

export { weekStartUtah };
