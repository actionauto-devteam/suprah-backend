import mongoose from 'mongoose';
import CallbackPermission from '../models/CallbackPermission.model';
import { IContactRestrictionAuditActor } from '../models/ContactRestrictionAudit.model';
import { matchableIdentityPhone } from '../utils/contactIdentity';
import logger from '../utils/logger';
import { recordContactRestrictionAudit, resolveContactRestriction } from './contactRestriction.service';

export const CALLBACK_WINDOW_HOURS = 24;
export const CALLBACK_WINDOW_MS = CALLBACK_WINDOW_HOURS * 60 * 60 * 1000;
export const CALLBACK_MAX_ATTEMPTS = 2;

export const OUTBOUND_CALL_MESSAGES = {
  restricted: `This customer is marked Do Not Contact, so you can't call them. You can only call back within ${CALLBACK_WINDOW_HOURS} hours after they call you, up to ${CALLBACK_MAX_ATTEMPTS} tries. Only an admin can remove Do Not Contact.`,
  triesUsed: `This customer is marked Do Not Contact. The ${CALLBACK_MAX_ATTEMPTS} tries to call back after their last call are used up. Only an admin can remove Do Not Contact.`,
  windowEnded: `This customer is marked Do Not Contact. The ${CALLBACK_WINDOW_HOURS} hours to call back after their last call have ended. Only an admin can remove Do Not Contact.`,
  unavailable: "We couldn't confirm this customer can be contacted, so the call wasn't placed. Please try again in a moment.",
};

export interface CallbackUse {
  permissionId: string;
  attempt: number;
  maxAttempts: number;
  expiresAt: Date;
}

export type OutboundCallDecision =
  | { allowed: true; callback: CallbackUse | null }
  | { allowed: false; status: 'restricted' | 'unavailable'; message: string; leadIds: string[] };

export async function grantCallbackPermission(call: {
  _id: unknown;
  orgId: unknown;
  from?: unknown;
  startedAt?: Date | null;
}): Promise<boolean> {
  const organizationId = String(call.orgId || '');
  const phone = matchableIdentityPhone(call.from);
  if (!phone || !mongoose.isValidObjectId(organizationId) || !mongoose.isValidObjectId(call._id)) return false;
  const check = await resolveContactRestriction({ organizationId, phone });
  if (check.status !== 'restricted') return false;
  const calledAt = new Date(call.startedAt || Date.now());
  const expiresAt = new Date(calledAt.getTime() + CALLBACK_WINDOW_MS);
  try {
    await CallbackPermission.findOneAndUpdate(
      { organizationId, phone, calledAt: { $lt: calledAt } },
      {
        $set: {
          sourceCallLogId: call._id,
          calledAt,
          expiresAt,
          maxAttempts: CALLBACK_MAX_ATTEMPTS,
          attemptsUsed: 0,
          attempts: [],
          restrictingLeadIds: check.leadIds,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  } catch (err: any) {
    if (err?.code === 11000) return false;
    throw err;
  }
  await recordContactRestrictionAudit({
    organizationId,
    event: 'callback_permission_granted',
    actor: { kind: 'system' },
    channel: 'call',
    purpose: 'customer_called',
    reason: `The customer called from ${phone}. Calling back is allowed until ${expiresAt.toISOString()}, up to ${CALLBACK_MAX_ATTEMPTS} tries.`,
    restrictingLeadIds: check.leadIds,
    callLogId: call._id,
  });
  return true;
}

async function useCallbackPermission(input: {
  organizationId: string;
  phone: string;
  actor: IContactRestrictionAuditActor;
  callLogId?: unknown;
  now: Date;
}): Promise<CallbackUse | null> {
  const permission: any = await CallbackPermission.findOneAndUpdate(
    {
      organizationId: input.organizationId,
      phone: input.phone,
      expiresAt: { $gt: input.now },
      $expr: { $lt: ['$attemptsUsed', '$maxAttempts'] },
    },
    {
      $inc: { attemptsUsed: 1 },
      $push: {
        attempts: {
          userId: input.actor.userId ?? null,
          name: input.actor.name ?? null,
          callLogId: input.callLogId ? String(input.callLogId) : null,
          at: input.now,
        },
      },
    },
    { new: true },
  ).lean();
  if (!permission) return null;
  return {
    permissionId: String(permission._id),
    attempt: permission.attemptsUsed,
    maxAttempts: permission.maxAttempts,
    expiresAt: new Date(permission.expiresAt),
  };
}

async function blockedCallMessage(organizationId: string, phone: string | null, now: Date): Promise<string> {
  if (!phone) return OUTBOUND_CALL_MESSAGES.restricted;
  const latest: any = await CallbackPermission.findOne({ organizationId, phone })
    .select('expiresAt attemptsUsed maxAttempts')
    .lean()
    .catch(() => null);
  if (!latest) return OUTBOUND_CALL_MESSAGES.restricted;
  if (new Date(latest.expiresAt).getTime() <= now.getTime()) return OUTBOUND_CALL_MESSAGES.windowEnded;
  return OUTBOUND_CALL_MESSAGES.triesUsed;
}

export async function authorizeOutboundCall(input: {
  organizationId: unknown;
  phone: unknown;
  leadId?: unknown;
  customerId?: unknown;
  actor: IContactRestrictionAuditActor;
  purpose: string;
  callLogId?: unknown;
  newCall?: boolean;
  allowWhenUnconfirmed?: boolean;
  now?: Date;
}): Promise<OutboundCallDecision> {
  const organizationId = String(input.organizationId || '');
  const now = input.now || new Date();
  const check = await resolveContactRestriction({
    organizationId,
    phone: input.phone,
    leadId: input.leadId,
    customerId: input.customerId,
  });
  if (check.status === 'allowed') return { allowed: true, callback: null };
  if (check.status === 'unavailable' && input.allowWhenUnconfirmed) {
    logger.warn({ organizationId, purpose: input.purpose }, '[CallbackPermission] Do Not Contact lookup failed after the call started; the call was not stopped');
    return { allowed: true, callback: null };
  }

  const phone = matchableIdentityPhone(input.phone);
  if (check.status === 'restricted' && phone) {
    try {
      const callback = await useCallbackPermission({ organizationId, phone, actor: input.actor, callLogId: input.callLogId, now });
      if (callback) {
        await recordContactRestrictionAudit({
          organizationId,
          leadId: input.leadId,
          event: 'callback_permission_used',
          actor: input.actor,
          channel: 'call',
          purpose: input.purpose,
          reason: `Call back ${callback.attempt} of ${callback.maxAttempts} to ${phone}, allowed until ${callback.expiresAt.toISOString()}.`,
          restrictingLeadIds: check.leadIds,
          callLogId: input.callLogId,
        });
        return { allowed: true, callback };
      }
    } catch (err) {
      logger.warn({ err, organizationId }, '[CallbackPermission] Could not use the callback permission; blocking the call');
    }
  }

  await recordContactRestrictionAudit({
    organizationId,
    leadId: input.leadId,
    event: 'outbound_blocked',
    actor: input.actor,
    channel: 'call',
    purpose: input.purpose,
    outcome: check.status,
    restrictingLeadIds: check.status === 'restricted' ? check.leadIds : [],
    callLogId: input.newCall ? null : input.callLogId,
  });
  if (check.status === 'unavailable') {
    return { allowed: false, status: 'unavailable', message: OUTBOUND_CALL_MESSAGES.unavailable, leadIds: [] };
  }
  return {
    allowed: false,
    status: 'restricted',
    message: await blockedCallMessage(organizationId, phone, now),
    leadIds: check.leadIds,
  };
}
