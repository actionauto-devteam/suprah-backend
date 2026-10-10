import mongoose from "mongoose";
import {
  Conversation,
  CommunicationMessage,
  CallLog,
  TelephonyCredential,
  IActorRef,
  ICommunicationMessage,
} from "../models/communication.model";
import * as telnyx from "./telnyx.service";
import { getSocketIO } from "../utils/socketEmitter";
import Organization from "../models/Organization.model";
import Appointment from "../models/Appointment.model";
import { notifyOrgAdmins } from "../utils/safeNotification";
import { createAiAgentTaskAndNotify } from "../utils/aiAgentTask";
import { addLeadNoteAndNotify, shouldSuppressHandoffNoteNotification } from "../utils/leadNote";
import { describeSmsFailure } from "../utils/smsFailure";
import { notificationTemplates } from "../utils/notificationTemplates";
import { CALENDAR_TZ } from "../constants/calendarTimezone";
import SmsOptOut from "../models/SmsOptOut.model";
import Vehicle from "../models/Vehicle.model";
import {
  resolveAiAgentSettings,
  processAlexTurn,
  AiAgentTranscriptEntry,
  HISTORY_LIMIT,
} from "./aiAgent.service";
import { getRelevantAiCoaching } from "./aiAgentCoaching.service";
import { resolveOrgSystemUserId } from "../utils/orgSystemUser";
import { retryDbWrite } from "../utils/retryDbWrite";
import { LEAD_SOURCE } from "../constants/leadSource";
import { getInboundRoutingConfig, getConfiguredInboundOrganization } from './callRoutingConfig.service';
import { IvrInboundClaim } from '../models/CallRoutingConfig.model';
import { AttentionCheck, beginAiAttentionCheck, finishAiAttentionCheck, screenAiHumanAttention,
  canSendAiReply, assertAiReplyAllowed, AiReplySuppressedError, claimAiGeneration, claimAiReplyDispatch,
  attentionOrgIds, recoverAiHumanAttention } from './aiHumanAttention.service';
import { initializeIvr, handleIvrGather, emitIvrCall, clearIvrTimer, canReceiveIvrCall, ivrAgentFailed, recoverIvrCalls } from './ivr.service';

const AI_AGENT_ACTOR_ID = "ai-agent";

function emitToOrg(orgId: any, event: string, payload: any) {
  try {
    const io = getSocketIO();
    if (!io || !orgId) return;
    io.to(`org:${String(orgId)}`).emit(event, { ...payload, orgId: String(orgId) });
  } catch {
    /* socket emission must never break a request or webhook */
  }
}

const RING_TIMEOUT_MS = 35_000;

/** Resolve the tenant dealership's display name for voice/SMS copy. */
export async function resolveDealerName(organizationId: any): Promise<string> {
  if (!organizationId) return "Your Dealership";
  try {
    const org = await Organization.findById(organizationId).select("name").lean();
    return org?.name || "Your Dealership";
  } catch {
    return "Your Dealership";
  }
}

/** Resolve the org's review link. Organization.metadata.reviewLinks holds
 *  per-location overrides (matched against Vehicle.dealerCity, case-
 *  insensitive); Organization.metadata.reviewLink is the default/fallback,
 *  used when no location is given or no location matches. Both are set via
 *  the org-settings PATCH. */
export async function resolveReviewLink(
  organizationId: any,
  dealerCity?: string | null,
): Promise<string | null> {
  if (!organizationId) return null;
  try {
    const org = await Organization.findById(organizationId).select("metadata").lean();
    const metadata = (org?.metadata as any) || {};

    if (dealerCity && dealerCity.trim()) {
      const target = dealerCity.trim().toLowerCase();
      const perLocation = Array.isArray(metadata.reviewLinks) ? metadata.reviewLinks : [];
      const match = perLocation.find(
        (row: any) => typeof row?.location === "string" && row.location.trim().toLowerCase() === target,
      );
      if (match?.url && typeof match.url === "string" && match.url.trim()) {
        return match.url.trim();
      }
    }

    const link = metadata.reviewLink;
    return typeof link === "string" && link.trim() ? link.trim() : null;
  } catch {
    return null;
  }
}

function buildMissedCallMessage(dealerName: string): string {
  return `Thank you for calling ${dealerName}. All of our team members are currently unavailable. Please send us a text message and we will get back to you as soon as possible.`;
}

function buildMissedCallTextBackMessage(dealerName: string): string {
  return `Sorry we missed your call, ${dealerName} here! Reply to this text and we'll get right back to you. Reply STOP to opt out.`;
}

function buildNoShowFollowUpMessage(
  dealerName: string,
  firstName: string,
  title: string,
  timeLabel: string
): string {
  return `Hi ${firstName}, ${dealerName} here. We missed you at your appointment "${title}" on ${timeLabel}. Reply to this text and we'll get you rebooked. Reply STOP to opt out.`;
}

const SYSTEM_ACTOR: IActorRef = { userId: "system", name: "Suprah AI" };

export class SmsDeliveryUncertainError extends Error {
  messageId: string;
  providerMessageId: string;
  constructor(message: string, info: { messageId: string; providerMessageId: string }) {
    super(message);
    this.name = "SmsDeliveryUncertainError";
    this.messageId = info.messageId;
    this.providerMessageId = info.providerMessageId;
  }
}

export async function isSmsOptedOut(orgId: any, phone: string): Promise<boolean> {
  const record: any = await SmsOptOut.findOne({
    organizationId: String(orgId),
    phone: normalizePhone(phone),
  })
    .select("optedOut")
    .lean();
  return Boolean(record?.optedOut);
}

export async function sendAutomatedSms(opts: {
  orgId: any;
  toPhone: string;
  body: string;
  customerId?: any;
  customerName?: string;
  leadId?: any;
}): Promise<boolean> {
  if (await isSmsOptedOut(opts.orgId, opts.toPhone)) return false;
  await sendSmsFromUser({ ...opts, user: SYSTEM_ACTOR });
  return true;
}

/** Same opt-out guard as sendAutomatedSms, but attributed to the staff
 *  member who actually triggered the send (e.g. a campaign) instead of the
 *  system actor, so the conversation thread shows who sent it. */
export async function sendStaffAttributedSms(opts: {
  orgId: any;
  toPhone: string;
  body: string;
  customerId?: any;
  customerName?: string;
  leadId?: any;
  actor: IActorRef;
  beforeSend?: () => Promise<void>;
  beforeDispatch?: () => Promise<void>;
}): Promise<false | Awaited<ReturnType<typeof sendSmsFromUser>>> {
  if (await isSmsOptedOut(opts.orgId, opts.toPhone)) return false;
  const { actor, ...rest } = opts;
  return sendSmsFromUser({ ...rest, user: actor });
}

async function sendMissedCallTextBack(call: any): Promise<void> {
  try {
    const dealerName = await resolveDealerName(call.orgId);
    await sendAutomatedSms({
      orgId: call.orgId,
      toPhone: call.from,
      body: buildMissedCallTextBackMessage(dealerName),
      customerId: call.customerId,
      customerName: call.customerName,
      leadId: call.leadId,
    });
  } catch (err) {
    console.error("[comm] missed-call text-back failed:", err);
  }
}

/** Customer phone fields to match inbound numbers against.
 *  Adjust to your Customer schema if needed. */

/* ------------------------------ phone utils ----------------------------- */

export function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  const only = digits.replace(/\D/g, "");
  if (only.length === 10) return `+1${only}`; // US default
  if (only.length === 11 && only.startsWith("1")) return `+${only}`;
  return `+${only}`;
}

const last10 = (p: string) => (p || "").replace(/\D/g, "").slice(-10);

/* --------------------------- customer matching -------------------------- */

export async function findCustomerByPhone(orgId: any, phone: string): Promise<any | null> {
  return findUniqueCustomerByPhone(String(orgId || ''), phone).catch(error => {
    console.error('[comm] Organization-scoped Customer lookup failed', error);
    return null;
  });
}

export async function findLeadByPhone(orgId: any, phone: string): Promise<any | null> {
  const normalizedPhone = normalizeIdentityPhone(phone);
  if (!orgId || !normalizedPhone) return null;
  let LeadModel: mongoose.Model<any>;
  try { LeadModel = mongoose.model('Lead'); } catch { return null; }
  const leads: any[] = [];
  const cursor = LeadModel.find({
    organizationId: orgId,
    $or: [{ normalizedPhone }, { normalizedPhone: null }],
  }).sort({ updatedAt: -1, _id: -1 }).maxTimeMS(5000).lean().cursor();
  try {
    for await (const lead of cursor) {
      if (normalizeIdentityPhone(lead.phone) === normalizedPhone) leads.push(lead);
    }
  } catch (error) {
    console.error('[comm] Organization-scoped Lead lookup failed', error);
    return null;
  } finally {
    await cursor.close();
  }
  if (!leads.length) return null;
  if (leads.some(lead => ['ambiguous', 'conflict'].includes(lead.customerLink?.status))) return null;
  const customers = new Set(leads.map(lead => String(lead.customerId || 'unresolved')));
  if (customers.size > 1) return null;
  return leads[0];
}

const CONFIRM_KEYWORDS = new Set(["YES", "Y", "CONFIRM", "CONFIRMED", "OK", "OKAY"]);
const RESCHEDULE_KEYWORDS = new Set(["NO", "N", "CANCEL", "RESCHEDULE", "CHANGE"]);
const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "END", "QUIT"]);
const OPT_IN_KEYWORDS = new Set(["START", "UNSTOP"]);

function normalizeSmsCommand(body: string): string {
  return (body || "").trim().toUpperCase().replace(/[.!?]+$/, "");
}

async function findAppointmentForReply(orgId: any, phone: string): Promise<any | null> {
  const tail = last10(phone);
  if (tail.length < 7) return null;

  const phoneFilter = { "customerBooking.phone": { $regex: `${tail.split("").join("[^0-9]*")}$` } };
  const baseFilter = {
    organizationId: orgId,
    entryType: "appointment",
    status: { $in: ["scheduled", "confirmed"] },
    ...phoneFilter,
  };
  const now = new Date();

  const reminded = await Appointment.findOne({
    ...baseFilter,
    reminderSent: true,
    startTime: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
  })
    .sort({ reminderSentAt: -1 })
    .catch(() => null);
  if (reminded) return reminded;

  return Appointment.findOne({
    ...baseFilter,
    startTime: { $gte: now },
  })
    .sort({ startTime: 1 })
    .catch(() => null);
}

function formatApptTimeForSms(date: Date): string {
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: CALENDAR_TZ,
  });
}

async function handleAppointmentSmsReply(orgId: any, from: string, body: string): Promise<boolean> {
  const command = normalizeSmsCommand(body);
  const isConfirm = CONFIRM_KEYWORDS.has(command);
  const isReschedule = RESCHEDULE_KEYWORDS.has(command);
  if (!isConfirm && !isReschedule) return false;

  const appointment = await findAppointmentForReply(orgId, from);
  if (!appointment) return true;

  const customerName =
    [appointment.customerBooking?.firstName, appointment.customerBooking?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || "The customer";

  try {
    if (isConfirm) {
      if (appointment.status !== "confirmed") {
        await Appointment.updateOne(
          { _id: appointment._id, status: appointment.status },
          {
            $set: { status: "confirmed" },
            $push: {
              statusHistory: {
                from: appointment.status,
                to: "confirmed",
                changedAt: new Date(),
                changedBy: "customer",
                actorName: customerName,
              },
            },
          },
        );
      }
      emitToOrg(orgId, "appointment:status_updated", {
        _id: appointment._id.toString(),
        status: "confirmed",
        orgId: String(orgId),
      });

      const timeLabel = formatApptTimeForSms(new Date(appointment.startTime));
      await sendAutomatedSms({
        orgId,
        toPhone: from,
        body: `You're confirmed for ${timeLabel}! See you then.`,
        leadId: appointment.leadId,
      });

      const { title, message } = notificationTemplates.appointment_confirmed_via_sms({
        customerName,
        appointmentTitle: appointment.title,
      });
      await notifyOrgAdmins(String(orgId), "appointment_confirmed_via_sms", title, message, {
        appointmentId: appointment._id.toString(),
      });
    } else {
      await Appointment.updateOne(
        { _id: appointment._id },
        { $set: { rescheduleAwaitingReplyAt: new Date() } },
      );

      await sendAutomatedSms({
        orgId,
        toPhone: from,
        body: "Got it! What day and time works best for you? We'll get you rebooked.",
        leadId: appointment.leadId,
      });

      const { title, message } = notificationTemplates.appointment_reschedule_requested({
        customerName,
        appointmentTitle: appointment.title,
      });
      await notifyOrgAdmins(String(orgId), "appointment_reschedule_requested", title, message, {
        appointmentId: appointment._id.toString(),
      });
    }
  } catch (err) {
    console.error("[comm] appointment SMS reply handling failed:", err);
  }

  return true;
}

const RESCHEDULE_REPLY_CAPTURE_WINDOW_HOURS = parseInt(
  process.env.RESCHEDULE_REPLY_CAPTURE_WINDOW_HOURS || "72",
  10,
);

/** Captures a customer's freeform reply to the "what day and time works
 *  best?" question sent after a RESCHEDULE keyword match. The raw text is
 *  stored as-is for a human to read and book — never auto-parsed into a real
 *  date/time, since a parsing error could create the wrong appointment slot.
 *  Bounded by a capture window so a much-later unrelated text is never
 *  misread as a stale reschedule answer. */
async function captureRescheduleReply(orgId: any, from: string, body: string): Promise<boolean> {
  const tail = last10(from);
  if (tail.length < 7) return false;

  const windowCutoff = new Date(Date.now() - RESCHEDULE_REPLY_CAPTURE_WINDOW_HOURS * 60 * 60 * 1000);
  const appointment = await Appointment.findOne({
    organizationId: orgId,
    entryType: "appointment",
    status: { $in: ["scheduled", "confirmed"] },
    "customerBooking.phone": { $regex: `${tail.split("").join("[^0-9]*")}$` },
    rescheduleAwaitingReplyAt: { $gte: windowCutoff },
  })
    .sort({ rescheduleAwaitingReplyAt: -1 })
    .catch(() => null);

  if (!appointment) return false;

  const trimmedBody = String(body || "").trim().slice(0, 300);
  if (!trimmedBody) return false;

  try {
    await Appointment.updateOne(
      { _id: appointment._id },
      {
        $set: { rescheduleStatedPreference: trimmedBody },
        $unset: { rescheduleAwaitingReplyAt: "" },
      },
    );

    await sendAutomatedSms({
      orgId,
      toPhone: from,
      body: "Thanks! We'll confirm your new time soon.",
      leadId: appointment.leadId,
    });

    const customerName =
      [appointment.customerBooking?.firstName, appointment.customerBooking?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim() || "The customer";

    const { title, message } = notificationTemplates.appointment_reschedule_preference_received({
      customerName,
      appointmentTitle: appointment.title,
      preference: trimmedBody,
    });
    await notifyOrgAdmins(String(orgId), "appointment_reschedule_preference_received", title, message, {
      appointmentId: appointment._id.toString(),
    });
  } catch (err) {
    console.error("[comm] reschedule reply capture failed:", err);
  }

  return true;
}

async function handleSmsOptCommand(orgId: any, from: string, body: string): Promise<boolean> {
  const command = normalizeSmsCommand(body);
  const isOptOut = OPT_OUT_KEYWORDS.has(command);
  const isOptIn = OPT_IN_KEYWORDS.has(command);
  if (!isOptOut && !isOptIn) return false;

  await SmsOptOut.updateOne(
    { organizationId: String(orgId), phone: normalizePhone(from) },
    { $set: { optedOut: isOptOut, changedAt: new Date(), keyword: command } },
    { upsert: true }
  );

  if (!isOptOut) return true;

  const lead = await findLeadByPhone(orgId, from);
  const customerName =
    [lead?.firstName, lead?.lastName].filter(Boolean).join(" ").trim() || normalizePhone(from);
  const { title, message } = notificationTemplates.sms_opt_out({ customerName, keyword: command });
  await notifyOrgAdmins(String(orgId), "sms_opt_out", title, message, {
    leadId: lead?._id ? String(lead._id) : undefined,
  });

  return true;
}

export async function notifyCustomerOfReschedule(appointment: any): Promise<boolean> {
  const phone = appointment.customerBooking?.phone;
  if (!phone) return false;

  const firstName = appointment.customerBooking?.firstName?.trim() || "there";
  const [dealerName, { enabled, agentName }] = await Promise.all([
    resolveDealerName(appointment.organizationId),
    resolveAiAgentSettings(String(appointment.organizationId)),
  ]);
  const timeLabel = formatApptTimeForSms(new Date(appointment.startTime));

  if (enabled) {
    const result = await sendStaffAttributedSms({
      orgId: appointment.organizationId,
      toPhone: phone,
      body: `Hi ${firstName}, it's ${agentName} from ${dealerName}. Quick update — your appointment has been moved to ${timeLabel}. See you then! Reply STOP to opt out.`,
      leadId: appointment.leadId,
      actor: { userId: AI_AGENT_ACTOR_ID, name: agentName },
    });
    return Boolean(result);
  }

  return sendAutomatedSms({
    orgId: appointment.organizationId,
    toPhone: phone,
    body: `Hi ${firstName}, ${dealerName} here. Your appointment has been moved to ${timeLabel}. Reply STOP to opt out.`,
    leadId: appointment.leadId,
  });
}

export async function sendNoShowFollowUpText(appointment: any): Promise<boolean> {
  const phone = appointment.customerBooking?.phone;
  if (!phone) return false;

  const firstName = appointment.customerBooking?.firstName?.trim() || "there";
  const dealerName = await resolveDealerName(appointment.organizationId);
  const timeLabel = formatApptTimeForSms(new Date(appointment.startTime));

  return sendAutomatedSms({
    orgId: appointment.organizationId,
    toPhone: phone,
    body: buildNoShowFollowUpMessage(dealerName, firstName, appointment.title, timeLabel),
    leadId: appointment.leadId,
  });
}

export function pickVariant<T>(variants: T[], seed: string): T {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return variants[hash % variants.length];
}

export type NurtureMessageBuilder = (dealerName: string, firstName: string, subject: string) => string;

export const NURTURE_MESSAGES: NurtureMessageBuilder[][] = [
  [
    (dealerName, firstName, subject) =>
      `Hi ${firstName}, ${dealerName} here. Just checking in on ${subject}. Do you have any questions I can help with? Reply anytime. Reply STOP to opt out.`,
    (dealerName, firstName, subject) =>
      `Hi ${firstName}, it's ${dealerName} — wanted to follow up on ${subject}. Anything I can answer for you? Reply STOP to opt out.`,
  ],
  [
    (dealerName, firstName, subject) =>
      `Hi ${firstName}, this is ${dealerName}. Would you like to set up a time to see ${subject} in person? Reply with a day that works for you and we'll get it scheduled. Reply STOP to opt out.`,
    (dealerName, firstName, subject) =>
      `Hi ${firstName}, ${dealerName} here again. If you'd like to come take a look at ${subject}, just reply with a day that works and we'll get you set up. Reply STOP to opt out.`,
  ],
  [
    (dealerName, firstName, subject) =>
      `Hi ${firstName}, ${dealerName} here. This is my last check-in on ${subject}. If you're still interested, just reply and we'll take it from there. No worries if not! Reply STOP to opt out.`,
    (dealerName, firstName, subject) =>
      `Hi ${firstName}, it's ${dealerName} one more time about ${subject}. Still interested? Just reply and we'll pick up from here — totally fine if not. Reply STOP to opt out.`,
  ],
];

export type ConversationPauseStatus = "unpaused" | "paused" | "unknown";

export interface ConversationPauseCheckResult {
  status: ConversationPauseStatus;
  reason?: string;
}

export async function checkConversationPauseForLead(opts: {
  organizationId: any;
  phone?: string | null;
  leadId?: any;
}): Promise<ConversationPauseCheckResult> {
  if (!opts.phone) return { status: "unpaused" };

  let conversation: any;
  try {
    conversation = await Conversation.findOne({
      orgId: { $in: attentionOrgIds(String(opts.organizationId)) },
      customerPhone: opts.phone,
    })
      .select("leadId aiPausedAt aiHumanAttention aiAutoPausedUntil")
      .lean();
  } catch (err) {
    console.error("[comm] checkConversationPauseForLead lookup failed:", err);
    return { status: "unknown", reason: "Could not confirm pause state (lookup failed)" };
  }

  if (!conversation) return { status: "unpaused" };

  if (conversation.leadId && opts.leadId && String(conversation.leadId) !== String(opts.leadId)) {
    return { status: "unknown", reason: "Could not confirm pause state (phone matched a different lead's conversation)" };
  }

  if (conversation.aiPausedAt || conversation.aiHumanAttention) {
    return { status: "paused", reason: "AI conversation is currently paused" };
  }
  if (conversation.aiAutoPausedUntil && new Date(conversation.aiAutoPausedUntil) > new Date()) {
    return { status: "paused", reason: "AI conversation is currently paused" };
  }

  return { status: "unpaused" };
}

export function shouldDeferAutomatedFollowUp(result: ConversationPauseCheckResult): boolean {
  return result.status !== "unpaused";
}

export async function sendLeadNurtureText(lead: any, step: number): Promise<boolean> {
  if (!lead.phone) return false;

  const firstName = lead.firstName?.trim() || "there";
  const dealerName = await resolveDealerName(lead.organizationId);
  const vehicleLabel = [lead.vehicle?.year, lead.vehicle?.make, lead.vehicle?.model]
    .filter(Boolean)
    .join(" ");
  const subject = vehicleLabel ? `the ${vehicleLabel}` : "the vehicle you asked about";
  const stepVariants = NURTURE_MESSAGES[Math.min(step, NURTURE_MESSAGES.length - 1)];
  const buildMessage = pickVariant(stepVariants, String(lead._id));

  return sendAutomatedSms({
    orgId: lead.organizationId,
    toPhone: lead.phone,
    body: buildMessage(dealerName, firstName, subject),
    leadId: lead._id,
  });
}

const REVIEW_REQUEST_WITH_LINK: Array<(dealerName: string, firstName: string, reviewLink: string) => string> = [
  (dealerName, firstName, reviewLink) =>
    `Hi ${firstName}, thanks for choosing ${dealerName}! If you have a minute, we'd really appreciate a quick review: ${reviewLink} Reply STOP to opt out.`,
  (dealerName, firstName, reviewLink) =>
    `Hi ${firstName}, it was great working with you at ${dealerName}! Mind leaving us a quick review? ${reviewLink} Reply STOP to opt out.`,
];

const REVIEW_REQUEST_WITHOUT_LINK: Array<(dealerName: string, firstName: string) => string> = [
  (dealerName, firstName) =>
    `Hi ${firstName}, thanks for choosing ${dealerName}! We'd love to hear how it went — reply and let us know. Reply STOP to opt out.`,
  (dealerName, firstName) =>
    `Hi ${firstName}, it was great working with you at ${dealerName}! How'd everything go? Reply and let us know. Reply STOP to opt out.`,
];

export function buildReviewRequestMessage(dealerName: string, firstName: string, reviewLink: string | null, seed: string): string {
  return reviewLink
    ? pickVariant(REVIEW_REQUEST_WITH_LINK, seed)(dealerName, firstName, reviewLink)
    : pickVariant(REVIEW_REQUEST_WITHOUT_LINK, seed)(dealerName, firstName);
}

export async function sendReviewRequestText(appointment: any): Promise<boolean> {
  const phone = appointment.customerBooking?.phone;
  if (!phone) return false;

  const firstName = appointment.customerBooking?.firstName?.trim() || "there";
  const dealerCity = appointment.vehicleId
    ? await Vehicle.findById(appointment.vehicleId).select("dealerCity").lean().then(
        (vehicle: any) => vehicle?.dealerCity || null,
        () => null,
      )
    : null;
  const [dealerName, reviewLink] = await Promise.all([
    resolveDealerName(appointment.organizationId),
    resolveReviewLink(appointment.organizationId, dealerCity),
  ]);

  return sendAutomatedSms({
    orgId: appointment.organizationId,
    toPhone: phone,
    body: buildReviewRequestMessage(dealerName, firstName, reviewLink, String(appointment._id)),
    leadId: appointment.leadId,
  });
}

function buildWebchatFallbackMessage(dealerName: string, firstName: string): string {
  return `Hi ${firstName}, ${dealerName} here. We got your message on our website chat and a team member will reply there shortly. Feel free to reply to this text instead if that's easier. Reply STOP to opt out.`;
}

export async function sendWebchatFallbackSms(opts: {
  orgId: any;
  phone: string;
  firstName?: string;
  leadId?: any;
}): Promise<boolean> {
  const dealerName = await resolveDealerName(opts.orgId);
  return sendAutomatedSms({
    orgId: opts.orgId,
    toPhone: opts.phone,
    body: buildWebchatFallbackMessage(dealerName, opts.firstName?.trim() || "there"),
    leadId: opts.leadId,
  });
}

/** Touch the lead so the unanswered-inquiry tracking and the leads list stay
 *  accurate when the customer texts in, and nudge the UI via lead:update. */
async function touchLeadOnInbound(leadId: any, orgId: any) {
  try {
    const LeadModel = mongoose.model("Lead");
    await LeadModel.updateOne(
      { _id: leadId, organizationId: orgId },
      {
        $set: {
          "followUp.lastCustomerActivityAt": new Date(),
          isRead: false,
        },
      }
    );
    emitToOrg(orgId, "lead:update", { leadId: String(leadId) });
  } catch {
    /* lead touch is best-effort */
  }
}

function customerDisplayName(c: any): string | undefined {
  if (!c) return undefined;
  return (
    c.name ||
    [c.firstName, c.lastName].filter(Boolean).join(" ") ||
    c.fullName ||
    undefined
  );
}

/* ------------------------------ conversations --------------------------- */

export async function getOrCreateConversation(opts: {
  orgId: any;
  phone: string;
  customerId?: any;
  customerName?: string;
  leadId?: any;
}) {
  const customerPhone = normalizePhone(opts.phone);
  const update: any = {
    $setOnInsert: { orgId: opts.orgId, customerPhone },
  };
  const set: any = {};
  if (opts.customerId) set.customerId = opts.customerId;
  if (opts.customerName) set.customerName = opts.customerName;
  if (opts.leadId) set.leadId = opts.leadId;
  if (Object.keys(set).length) update.$set = set;

  return Conversation.findOneAndUpdate(
    { orgId: opts.orgId, customerPhone },
    update,
    { new: true, upsert: true }
  );
}

/** Atomically create-or-match a Lead for an unrecognized SMS/call contact.
 *  Uses the Conversation this contact already converges on (both channels
 *  share the same {orgId, customerPhone} document via getOrCreateConversation)
 *  as the mutual-exclusion gate: claim its `leadId` first (pre-generated, so
 *  two simultaneous events for the same new number can never both win), then
 *  create the Lead, rolling the claim back if creation fails. */
export async function findOrCreateLeadForContact(opts: {
  orgId: any;
  conversation: any;
  existingLead: any | null;
  phone: string;
  customer: any | null;
  channel: "sms" | "phone";
}): Promise<{ lead: any | null; created: boolean }> {
  if (opts.existingLead?._id) return { lead: opts.existingLead, created: false };

  let LeadModel: mongoose.Model<any> | null = null;
  try {
    LeadModel = mongoose.model("Lead");
  } catch {
    return { lead: null, created: false };
  }

  if (opts.conversation.leadId) {
    const alreadyLinked = await LeadModel.findOne({ _id: opts.conversation.leadId, organizationId: opts.orgId });
    if (!alreadyLinked || normalizeIdentityPhone(alreadyLinked.phone) !== normalizeIdentityPhone(opts.phone)) return { lead: null, created: false };
    return { lead: alreadyLinked, created: false };
  }

  const candidateId = new mongoose.Types.ObjectId();
  const claimed = await Conversation.findOneAndUpdate(
    { _id: opts.conversation._id, leadId: null },
    { $set: { leadId: candidateId } },
    { new: true }
  );

  if (!claimed) {
    const fresh: any = await Conversation.findById(opts.conversation._id).select("leadId").lean();
    if (!fresh?.leadId) return { lead: null, created: false };

    // The winner's Conversation claim can resolve microseconds before its
    // Lead.create() finishes writing — these are two separate operations,
    // not one atomic unit. Poll briefly rather than returning null on a
    // near-simultaneous loss (a real gap a mocked-concurrency test can't
    // surface; caught by a real-DB Promise.all race during Stage 36 review).
    for (let attempt = 0; attempt < 10; attempt++) {
      const winnerLead = await LeadModel.findOne({ _id: fresh.leadId, organizationId: opts.orgId });
      if (winnerLead) return { lead: winnerLead, created: false };
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { lead: null, created: false };
  }

  try {
    const systemUserId = await resolveOrgSystemUserId(opts.orgId);
    if (!systemUserId) throw new Error("No org system user configured for this organization");

    const displayName = customerDisplayName(opts.customer);
    const [firstName, ...rest] = (displayName || "").trim().split(/\s+/).filter(Boolean);

    const lead = await LeadModel.create({
      _id: candidateId,
      organizationId: opts.orgId,
      createdBy: systemUserId,
      firstName: firstName || "Unknown",
      lastName: rest.join(" "),
      phone: opts.phone,
      channel: opts.channel,
      source: opts.channel === "sms" ? LEAD_SOURCE.INBOUND_SMS : LEAD_SOURCE.INBOUND_CALL,
      status: "New",
    });

    return { lead, created: true };
  } catch (err) {
    await Conversation.updateOne(
      { _id: opts.conversation._id, leadId: candidateId },
      { $set: { leadId: null } }
    ).catch(() => {});
    console.error("[comm] findOrCreateLeadForContact: Lead creation failed after claim", err);
    return { lead: null, created: false };
  }
}

/* --------------------------------- SMS ---------------------------------- */

export async function sendSmsFromUser(opts: {
  orgId: any;
  user: IActorRef;
  toPhone: string;
  body: string;
  customerId?: any;
  customerName?: string;
  leadId?: any;
  beforeSend?: () => Promise<void>;
  beforeDispatch?: () => Promise<void>;
}) {
  const to = normalizePhone(opts.toPhone);
  const body = (opts.body || "").trim();
  if (!body) throw Object.assign(new Error("Message body is required"), { statusCode: 400 });
  if (!telnyx.COMPANY_NUMBER)
    throw Object.assign(new Error("TELNYX_PHONE_NUMBER is not configured"), { statusCode: 500 });

  // Resolve customer / lead if not provided
  let customerId = opts.customerId ?? null;
  let customerName = opts.customerName;
  let leadId = opts.leadId ?? null;
  if (!customerId) {
    const c = await findCustomerByPhone(opts.orgId, to);
    if (c) {
      customerId = c._id;
      customerName = customerName || customerDisplayName(c);
    }
  }
  if (!leadId) {
    const lead = await findLeadByPhone(opts.orgId, to);
    if (lead) leadId = lead._id;
  }

  const conversation = await getOrCreateConversation({
    orgId: opts.orgId,
    phone: to,
    customerId,
    customerName,
    leadId,
  });

  await opts.beforeSend?.();
  const message = await CommunicationMessage.create({
    orgId: opts.orgId,
    conversationId: conversation._id,
    customerId,
    leadId,
    direction: "outbound",
    body,
    from: telnyx.COMPANY_NUMBER,
    to,
    status: "queued",
    sentBy: opts.user,
  });

  try {
    await opts.beforeSend?.();
    await opts.beforeDispatch?.();
    const sent = await telnyx.sendSms(to, body);
    try {
      message.providerMessageId = sent.id;
      message.status = "sent";
      message.sentAt = new Date();
      await message.save();
    } catch (saveErr: any) {
      await retryDbWrite(() =>
        CommunicationMessage.updateOne(
          { _id: message._id },
          { $set: { providerMessageId: sent.id, status: "pending_reconciliation", sentAt: new Date() } },
        ),
      ).catch(() => undefined);
      throw new SmsDeliveryUncertainError(
        "SMS was accepted by the provider but the local send record could not be confirmed",
        { messageId: String(message._id), providerMessageId: sent.id },
      );
    }
  } catch (err: any) {
    if (err instanceof SmsDeliveryUncertainError) throw err;
    if (err instanceof AiReplySuppressedError) {
      await CommunicationMessage.deleteOne({ _id: message._id, orgId: opts.orgId, status: 'queued' });
      throw err;
    }
    message.status = "failed";
    message.errorDetail = String(err?.message || err).slice(0, 500);
    await message.save();
    await bumpConversation(conversation._id, message);
    emitToOrg(opts.orgId, "comm:message:new", { message: message.toObject() });
    throw Object.assign(new Error("SMS provider rejected the message"), {
      statusCode: 502,
      detail: message.errorDetail,
    });
  }

  await bumpConversation(conversation._id, message);
  emitToOrg(opts.orgId, "comm:message:new", { message: message.toObject() });
  return { conversation, message };
}

async function bumpConversation(conversationId: any, message: any) {
  await Conversation.updateOne(
    { _id: conversationId },
    {
      $set: {
        lastMessageAt: message.createdAt || new Date(),
        lastMessagePreview: String(message.body).slice(0, 140),
        lastDirection: message.direction,
      },
      $inc: { messageCount: 1 },
    }
  );
}

async function buildSmsTranscript(conversationId: any): Promise<AiAgentTranscriptEntry[]> {
  const messages = await CommunicationMessage.find({ conversationId })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT)
    .lean();

  return messages.reverse().map((m: any): AiAgentTranscriptEntry => {
    if (m.direction === "inbound") return { from: "customer", body: m.body };
    if (m.sentBy?.userId === AI_AGENT_ACTOR_ID) return { from: "ai", body: m.body };
    return { from: "staff", staffName: m.sentBy?.name, body: m.body };
  });
}

/** Fire-and-forget: generates and sends Alex's next SMS reply for this
 *  conversation, if the org has Alex enabled, the number isn't paused, and
 *  the inbound message wasn't already handled by the STOP or appointment
 *  keyword handlers. Skipped entirely when the number doesn't match a Lead —
 *  Alex only operates within a lead conversation. */
export async function triggerSmsAiReply(orgId: any, conversation: any, lead: any, check: AttentionCheck, body: string, screened = false): Promise<void> {
  if (!lead?._id) return;

  try {
    const { enabled, agentName } = await resolveAiAgentSettings(String(orgId));
    if (!enabled) { await finishAiAttentionCheck(check); return; }
    if (!screened && !(await screenAiHumanAttention({ ...check, leadId: String(lead._id), body, agentName, phone: conversation.customerPhone }))) return;

    const claimed = await claimAiGeneration(check);
    if (!claimed) return;

    try {
      const [transcript, repliesSentToday, priorAiReplyCount, dealerName, coaching] = await Promise.all([
        buildSmsTranscript(conversation._id),
        CommunicationMessage.countDocuments({
          conversationId: conversation._id,
          direction: "outbound",
          "sentBy.userId": AI_AGENT_ACTOR_ID,
          createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        }),
        CommunicationMessage.countDocuments({
          conversationId: conversation._id,
          direction: "outbound",
          "sentBy.userId": AI_AGENT_ACTOR_ID,
        }),
        resolveDealerName(orgId),
        getRelevantAiCoaching({ organizationId: String(orgId), channel: "sms" }),
      ]);

      const vehicleInterest = lead.vehicle
        ? [lead.vehicle.year, lead.vehicle.make, lead.vehicle.model].filter(Boolean).join(" ")
        : undefined;

      await processAlexTurn({
        organizationId: String(orgId),
        leadId: String(lead._id),
        channel: "sms",
        conversationId: String(conversation._id),
        agentName,
        dealerName,
        customerFirstName: lead.firstName,
        leadVehicleInterest: vehicleInterest,
        phone: conversation.customerPhone,
        transcript,
        repliesSentToday,
        isFirstReply: priorAiReplyCount === 0,
        coachingNotes: coaching.notes,
        coachingRuleIds: coaching.ids,
        coachingRules: coaching.rules,
        send: async (text: string) => {
          const result = await sendStaffAttributedSms({
            orgId,
            toPhone: conversation.customerPhone,
            body: text,
            leadId: lead._id,
            customerId: conversation.customerId,
            actor: { userId: AI_AGENT_ACTOR_ID, name: agentName },
            beforeSend: async () => {
              if (await isSmsOptedOut(orgId, conversation.customerPhone)) throw new AiReplySuppressedError();
              await assertAiReplyAllowed(check);
            },
            beforeDispatch: () => claimAiReplyDispatch(check),
          });
          if (!result) throw new AiReplySuppressedError();
          return { messageId: String(result.message._id) };
        },
        notifyHandoff: async (reason) => {
          const customerName =
            [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || "A customer";
          const taskResult = await createAiAgentTaskAndNotify({
            organizationId: String(orgId),
            leadId: String(lead._id),
            channel: "sms",
            question: reason,
            agentName,
            customerName,
            assignedTo: lead.assignedTo ? String(lead.assignedTo) : null,
          });
          try {
            const mentionedUserIds = lead.assignedTo ? [String(lead.assignedTo)] : [];
            let mentionedGroupIds: string[] = [];
            if (!lead.assignedTo) {
              const org = await Organization.findById(orgId).select("metadata").lean();
              const fallbackGroupId = (org?.metadata as any)?.aiHandoffFallbackGroupId;
              if (fallbackGroupId) mentionedGroupIds = [String(fallbackGroupId)];
            }
            await addLeadNoteAndNotify({
              organizationId: String(orgId),
              leadId: String(lead._id),
              text: reason || "Needs human follow-up",
              authorType: "ai",
              authorName: agentName,
              mentionedUserIds,
              mentionedGroupIds,
              suppressNotification: shouldSuppressHandoffNoteNotification(lead.assignedTo, Boolean(taskResult?.notified)),
            });
          } catch (err) {
            console.error("[comm] Alex handoff note failed:", err);
          }
        },
        notifyMilestone: async (note) => {
          try {
            await addLeadNoteAndNotify({
              organizationId: String(orgId),
              leadId: String(lead._id),
              text: note,
              authorType: "ai",
              authorName: agentName,
              milestone: true,
            });
          } catch (err) {
            console.error("[comm] Alex milestone note failed:", err);
          }
        },
        onCapExceeded: async () => {
          await Conversation.updateOne(
            { _id: conversation._id, orgId },
            { $set: { aiPausedAt: new Date(), aiPausedBy: { userId: "system", name: "Suprah AI" } } },
          );
          emitToOrg(orgId, "comm:ai_paused", {
            conversationId: String(conversation._id),
            paused: true,
            pausedBy: "Suprah AI",
          });
        },
        isPausedNow: async () => {
          return !(await canSendAiReply(check));
        },
      });
    } finally {
      await Conversation.updateOne({ _id: conversation._id, orgId, aiGeneratingAt: claimed.aiGeneratingAt }, { $unset: { aiGeneratingAt: "" } });
    }
  } catch (err) {
    console.error("[comm] Alex trigger failed:", err);
  }
}

export async function triggerAiReplyForNewInquiry(orgId: any, lead: any, phone: string, inquiryText: string): Promise<void> {
  const text = String(inquiryText || "").trim();
  const rawPhone = String(phone || "").trim();
  if (!rawPhone || !text || !lead?._id) return;
  const normalizedPhone = normalizePhone(rawPhone);
  if (!normalizedPhone || normalizedPhone === "+") return;

  try {
    const LeadModel = mongoose.model("Lead");
    const claimed = await LeadModel.findOneAndUpdate(
      { _id: lead._id, organizationId: orgId, aiFirstReplyTriggeredAt: null },
      { $set: { aiFirstReplyTriggeredAt: new Date() } },
    );
    if (!claimed) return;

    const conversation = await getOrCreateConversation({
      orgId,
      phone: normalizedPhone,
      leadId: lead._id,
      customerName: `${lead.firstName || ""} ${lead.lastName || ""}`.trim() || undefined,
    });

    const messageId = new mongoose.Types.ObjectId();
    const check = await beginAiAttentionCheck({
      organizationId: String(orgId),
      channel: "sms",
      targetId: String(conversation._id),
      messageId: String(messageId),
    });
    const message = await CommunicationMessage.create({
      _id: messageId,
      orgId,
      conversationId: conversation._id,
      leadId: lead._id,
      direction: "inbound",
      body: text,
      from: normalizedPhone,
      to: telnyx.COMPANY_NUMBER,
      status: "received",
    });

    await bumpConversation(conversation._id, message);
    await touchLeadOnInbound(lead._id, orgId);
    emitToOrg(orgId, "comm:message:new", {
      message: message.toObject(),
      conversation: {
        _id: conversation._id,
        customerPhone: conversation.customerPhone,
        customerName: conversation.customerName,
        customerId: conversation.customerId,
        leadId: conversation.leadId,
      },
    });

    await triggerSmsAiReply(orgId, conversation, lead, check, text);
  } catch (err) {
    console.error("[comm] triggerAiReplyForNewInquiry failed:", err);
  }
}

/** Inbound SMS from Telnyx webhook (message.received). */
export async function handleInboundSms(payload: any, orgOverride?: any) {
  const from = normalizePhone(payload?.from?.phone_number || payload?.from || "");
  const toEntry = Array.isArray(payload?.to) ? payload.to[0] : payload?.to;
  const to = normalizePhone(toEntry?.phone_number || toEntry || telnyx.COMPANY_NUMBER);
  const body = payload?.text || "";
  const providerMessageId = payload?.id;

  if (!from || !body) return null;

  // Which org owns this number? Single-number setup: resolve org from env or
  // the first conversation. For a single-org deployment set COMM_ORG_ID.
  const orgId = orgOverride ?? (await resolveOrgForNumber(to));
  if (!orgId) {
    console.error("[comm] inbound SMS but COMM_ORG_ID is not configured");
    return null;
  }

  if (providerMessageId) {
    const dupe = await CommunicationMessage.findOne({ providerMessageId,
      orgId: { $in: attentionOrgIds(String(orgId)) } }).lean<ICommunicationMessage>();
    if (dupe) {
      const { enabled, agentName } = await resolveAiAgentSettings(String(orgId));
      if (enabled) await recoverAiHumanAttention({ organizationId: String(orgId), channel: 'sms',
        targetId: String(dupe.conversationId), messageId: String(dupe._id), body: dupe.body, createdAt: dupe.createdAt, agentName });
      return dupe;
    }
  }

  const customer = await findCustomerByPhone(orgId, from);
  let lead = await findLeadByPhone(orgId, from);
  const conversation = await getOrCreateConversation({
    orgId,
    phone: from,
    customerId: customer?._id,
    customerName:
      customerDisplayName(customer) ||
      (lead ? `${lead.firstName || ""} ${lead.lastName || ""}`.trim() || undefined : undefined),
    leadId: lead?._id,
  });

  const messageId = new mongoose.Types.ObjectId();
  const check = await beginAiAttentionCheck({ organizationId: String(orgId), channel: 'sms',
    targetId: String(conversation._id), messageId: String(messageId) });
  const message = await CommunicationMessage.create({
    _id: messageId,
    orgId,
    conversationId: conversation._id,
    customerId: customer?._id ?? null,
    leadId: lead?._id ?? null,
    direction: "inbound",
    body,
    from,
    to,
    status: "received",
    providerMessageId,
  });

  await bumpConversation(conversation._id, message);
  if (lead?._id) await touchLeadOnInbound(lead._id, orgId);
  emitToOrg(orgId, "comm:message:new", {
    message: message.toObject(),
    conversation: {
      _id: conversation._id,
      customerPhone: conversation.customerPhone,
      customerName: conversation.customerName,
      customerId: conversation.customerId,
      leadId: conversation.leadId,
    },
  });

  const optHandled = await handleSmsOptCommand(orgId, from, body).catch((err) => {
    console.error("[comm] handleSmsOptCommand failed:", err);
    return false;
  });

  const appointmentHandled = await handleAppointmentSmsReply(orgId, from, body).catch((err) => {
    console.error("[comm] handleAppointmentSmsReply failed:", err);
    return false;
  });
  let screened = false;
  if (!optHandled && !appointmentHandled && lead?._id) {
    const { enabled, agentName } = await resolveAiAgentSettings(String(orgId));
    if (enabled) {
      if (!(await screenAiHumanAttention({ ...check, leadId: String(lead._id), body, agentName, phone: conversation.customerPhone }))) return message;
      screened = true;
    }
  }
  const rescheduleReplyHandled =
    !optHandled && !appointmentHandled
      ? await captureRescheduleReply(orgId, from, body).catch((err) => {
          console.error("[comm] captureRescheduleReply failed:", err);
          return false;
        })
      : false;

  if (!optHandled && !appointmentHandled && !rescheduleReplyHandled) {
    if (!lead) {
      const result = await findOrCreateLeadForContact({
        orgId,
        conversation,
        existingLead: null,
        phone: from,
        customer,
        channel: "sms",
      }).catch((err) => {
        console.error("[comm] findOrCreateLeadForContact (sms) failed:", err);
        return { lead: null, created: false };
      });
      lead = result.lead;

      if (lead) {
        await CommunicationMessage.updateOne(
          { _id: message._id },
          { $set: { leadId: lead._id, ...(lead.customerLink?.status === 'linked' ? { customerId: lead.customerId } : {}) } }
        ).catch(() => {});
        emitToOrg(orgId, "lead:new", lead.toObject ? lead.toObject() : lead);

        if (result.created) {
          const customerNameForNotice =
            [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() || "A new customer";
          const { title, message: notificationMessage } = notificationTemplates.new_lead({
            customerName: customerNameForNotice,
            source: LEAD_SOURCE.INBOUND_SMS,
          });
          notifyOrgAdmins(String(orgId), "new_lead", title, notificationMessage, {
            leadId: String(lead._id),
            customerName: customerNameForNotice,
            source: LEAD_SOURCE.INBOUND_SMS,
            channel: "sms",
          }).catch(() => undefined);
        }
      }
    }

    triggerSmsAiReply(orgId, conversation, lead, check, body, screened).catch((err) => {
      console.error("[comm] triggerSmsAiReply failed:", err);
    });
  } else {
    await finishAiAttentionCheck(check);
  }

  return message;
}

/** Delivery receipts (message.sent / message.finalized). */
export async function handleSmsStatus(payload: any) {
  const providerMessageId = payload?.id;
  if (!providerMessageId) return;

  const toEntry = Array.isArray(payload?.to) ? payload.to[0] : null;
  const carrierStatus = toEntry?.status || payload?.status; // delivered | sending_failed | delivery_failed | sent ...

  let status: string | null = null;
  if (carrierStatus === "delivered") status = "delivered";
  else if (String(carrierStatus || "").includes("failed")) status = "failed";
  else if (carrierStatus === "sent") status = "sent";
  if (!status) return;

  const update: any = { status };
  if (status === "delivered") update.deliveredAt = new Date();
  if (status === "failed" && toEntry?.errors?.length)
    update.errorDetail = JSON.stringify(toEntry.errors).slice(0, 500);

  const message = await CommunicationMessage.findOneAndUpdate(
    { providerMessageId },
    { $set: update },
    { new: true }
  );
  if (message) {
    emitToOrg(message.orgId, "comm:message:status", {
      messageId: message._id,
      conversationId: message.conversationId,
      status: message.status,
    });
  }
}

/* ------------------------------ org resolution --------------------------- */
/** Single shared number → single org. Set COMM_ORG_ID in env. */
async function resolveOrgForNumber(_number: string): Promise<any | null> {
  if (process.env.COMM_ORG_ID) return process.env.COMM_ORG_ID;
  const anyConv: any = await Conversation.findOne().sort({ createdAt: 1 }).lean();
  return anyConv?.orgId ?? null;
}

/* ------------------------------ voice: inbound --------------------------- */

const ringTimers = new Map<string, NodeJS.Timeout>();

async function finishIvrMissed(call: any): Promise<void> {
  const claimed = await CallLog.findOneAndUpdate({ _id: call._id, status: 'missed', textBackSentAt: null }, {
    $set: { textBackSentAt: new Date() },
  }, { new: true });
  if (!claimed) return;
  const dealerName = await resolveDealerName(call.orgId);
  if (call.routing.customerAnswered) {
    await telnyx.speakIvr(call.providerCallControlId, buildMissedCallMessage(dealerName), {
      kind: 'ivr-missed', callLogId: String(call._id), revision: call.routing.revision,
    }).catch(() => telnyx.hangupCall(call.providerCallControlId).catch(() => {}));
  } else await telnyx.playMissedAndHangup(call.providerCallControlId, buildMissedCallMessage(dealerName));
  const timer = setTimeout(() => telnyx.hangupCall(call.providerCallControlId).catch(() => {}), 15000);
  timer.unref();
  await sendMissedCallTextBack(claimed);
}

const ivrCallbacks = { missed: finishIvrMissed };

export async function handleCallGatherEnded(payload: any): Promise<void> {
  await handleIvrGather(payload, ivrCallbacks);
}

export async function recoverPendingIvrCalls(orgId?: string): Promise<void> {
  await recoverIvrCalls(ivrCallbacks, orgId);
}

function emitCallUpdate(call: any): void {
  if (call.routing) emitIvrCall(call);
  else emitToOrg(call.orgId, 'comm:call:update', { call: call.toObject() });
}

/** call.initiated webhook. Fresh inbound calls create a ringing CallLog and
 *  broadcast to every online agent. Agent legs (tagged via client_state) and
 *  our own outbound Call Control legs are ignored here. */
export async function handleCallInitiated(payload: any) {
  const direction = payload?.direction; // "incoming" | "outgoing"
  const clientState = decodeClientState(payload?.client_state);
  if (clientState?.kind === 'recording-outbound') return;
  if (clientState?.kind === 'agent-leg') {
    if (clientState.revision !== undefined) {
      const active = await CallLog.findOneAndUpdate({ _id: clientState.callLogId, 'routing.revision': clientState.revision, $or: [
        { status: 'answering' }, { status: 'in-progress', agentLegCallControlId: payload.call_control_id },
      ] }, {
        $set: { agentLegCallControlId: payload.call_control_id },
      }, { new: true });
      if (!active) await telnyx.hangupCall(payload.call_control_id).catch(() => {});
    }
    return;
  }
  if (direction !== 'incoming') return;

  const callControlId = payload?.call_control_id;
  const callSessionId = payload?.call_session_id;
  const from = normalizePhone(payload?.from || "");
  const to = normalizePhone(payload?.to || telnyx.COMPANY_NUMBER);

  // Idempotency
  const existing = await CallLog.findOne({ providerCallControlId: callControlId }).lean();
  if (existing) return;

  let inboundRouting = await getInboundRoutingConfig(to);
  const orgId = inboundRouting?.orgId ?? await getConfiguredInboundOrganization(to) ?? await resolveOrgForNumber(to);
  if (!orgId) return;

  if (inboundRouting) {
    try { await IvrInboundClaim.create({ callControlId, organizationId: orgId }); }
    catch (error: any) {
      if (error?.code === 11000) return;
      console.error('[ivr] Could not reserve inbound call; using legacy inbound flow', error);
      inboundRouting = null;
    }
  }

  const customer = await findCustomerByPhone(orgId, from);
  let lead = await findLeadByPhone(orgId, from);
  const displayName =
    customerDisplayName(customer) ||
    (lead ? `${lead.firstName || ""} ${lead.lastName || ""}`.trim() || undefined : undefined);
  const conversation = await getOrCreateConversation({
    orgId,
    phone: from,
    customerId: customer?._id,
    customerName: displayName,
    leadId: lead?._id,
  });

  if (!lead) {
    const result = await findOrCreateLeadForContact({
      orgId,
      conversation,
      existingLead: null,
      phone: from,
      customer,
      channel: "phone",
    }).catch((err) => {
      console.error("[comm] findOrCreateLeadForContact (call) failed:", err);
      return { lead: null, created: false };
    });
    lead = result.lead;
    if (lead && result.created) {
      emitToOrg(orgId, "lead:new", lead.toObject ? lead.toObject() : lead);
    }
  }

  const call = await CallLog.create({
    orgId,
    customerId: lead?.customerLink?.status === 'linked' ? lead.customerId : customer?._id ?? null,
    leadId: lead?._id ?? null,
    conversationId: conversation._id,
    direction: "inbound",
    from,
    to,
    status: inboundRouting ? 'ivr' : 'ringing',
    providerCallControlId: callControlId,
    providerCallSessionId: callSessionId,
    startedAt: new Date(),
    customerName: displayName,
  });

  if (inboundRouting && await initializeIvr(call, inboundRouting.config, ivrCallbacks)) return;
  const legacyCall = inboundRouting ? await CallLog.findById(call._id) : call;
  emitToOrg(orgId, "comm:call:incoming", { call: legacyCall.toObject() });

  // Nobody answers → answer, apologize, hang up, mark missed.
  const timer = setTimeout(async () => {
    ringTimers.delete(String(call._id));
    const still = await CallLog.findOneAndUpdate(
      { _id: call._id, status: "ringing" },
      { $set: { status: "missed", endedAt: new Date(), textBackSentAt: new Date() } },
      { new: true }
    );
    if (still) {
      emitToOrg(orgId, "comm:call:update", { call: still.toObject() });
      const dealerName = await resolveDealerName(orgId);
      await telnyx.playMissedAndHangup(callControlId, buildMissedCallMessage(dealerName)).catch(() => {});
      await sendMissedCallTextBack(still);
    }
  }, RING_TIMEOUT_MS);
  ringTimers.set(String(call._id), timer);
}

/** Atomic first-to-answer claim. Two agents clicking Answer at once: exactly
 *  one findOneAndUpdate wins; the loser gets null and a 409. */
export async function claimInboundCall(opts: { callId: string; orgId: any; user: IActorRef }) {
  const pending = await CallLog.findOne({ _id: opts.callId, orgId: opts.orgId, status: 'ringing' });
  if (!pending) throw Object.assign(new Error('Call already answered or ended'), { statusCode: 409 });
  if (pending?.routing && !await canReceiveIvrCall(pending, String(opts.user.userId))) {
    throw Object.assign(new Error('This call is routed to another group'), { statusCode: 403 });
  }
  const call = await CallLog.findOneAndUpdate(
    { _id: opts.callId, orgId: opts.orgId, status: "ringing", ...(pending?.routing ? { 'routing.revision': pending.routing.revision } : {}) },
    { $set: { status: "answering", answeredBy: opts.user } },
    { new: true }
  );
  if (!call) {
    throw Object.assign(new Error("Call already answered or ended"), { statusCode: 409 });
  }

  const timer = ringTimers.get(String(call._id));
  if (timer && !call.routing) {
    clearTimeout(timer);
    ringTimers.delete(String(call._id));
  }

  const cred: any = await TelephonyCredential.findOne({ userId: opts.user.userId }).lean();
  if (!cred) {
    // Roll back so another agent can take it.
    await CallLog.updateOne(
      { _id: call._id, status: "answering" },
      { $set: { status: "ringing", answeredBy: null } }
    );
    throw Object.assign(
      new Error("Your softphone is not registered yet — open the communications panel first"),
      { statusCode: 428 }
    );
  }

  try {
    await telnyx.transferToAgent(call.providerCallControlId!, cred.sipUsername, {
      kind: "agent-leg",
      callLogId: String(call._id),
      userId: String(opts.user.userId),
      ...(call.routing ? { revision: call.routing.revision } : {}),
    });
  } catch (err: any) {
    if (call.routing) {
      await ivrAgentFailed(call, ivrCallbacks);
      throw Object.assign(new Error('Could not bridge the call; trying the fallback route'), { statusCode: 502 });
    }
    await CallLog.updateOne(
      { _id: call._id },
      { $set: { status: "failed", hangupCause: String(err?.message).slice(0, 200), endedAt: new Date() } }
    );
    const failed = await CallLog.findById(call._id);
    if (failed) emitToOrg(opts.orgId, "comm:call:update", { call: failed.toObject() });
    throw Object.assign(new Error("Could not bridge the call"), { statusCode: 502 });
  }

  emitCallUpdate(call);
  return call;
}

/** call.answered — the agent leg picked up → call is live. */
export async function handleCallAnswered(payload: any) {
  const clientState = decodeClientState(payload?.client_state);
  const sessionId = payload?.call_session_id;

  const query = clientState?.callLogId
    ? { _id: clientState.callLogId }
    : { providerCallSessionId: sessionId };

  const existingCall = await CallLog.findOne(query);
  if (existingCall?.routing) {
    if (clientState?.kind !== 'agent-leg' || clientState.revision !== existingCall.routing.revision || existingCall.status !== 'answering') return;
  } else if (String(clientState?.kind || '').startsWith('ivr-')) return;

  const call = await CallLog.findOneAndUpdate(
    { ...query, status: { $in: ["ringing", "answering"] }, ...(existingCall?.routing ? { 'routing.revision': existingCall.routing.revision } : {}) },
    {
      $set: {
        status: "in-progress",
        answeredAt: new Date(),
        ...(clientState?.kind === "agent-leg" && payload?.call_control_id
          ? { agentLegCallControlId: payload.call_control_id }
          : {}),
      },
    },
    { new: true }
  );
  if (call) {
    if (call.routing) clearIvrTimer(String(call._id));
    emitCallUpdate(call);
  }
}

/** call.hangup — finalize whichever leg ends the session. */
export async function handleCallHangup(payload: any) {
  const sessionId = payload?.call_session_id;
  const clientState = decodeClientState(payload?.client_state);
  const cause = payload?.hangup_cause;

  const query: any = clientState?.callLogId
    ? { _id: clientState.callLogId }
    : { providerCallSessionId: sessionId };

  const call = await CallLog.findOne(query);
  if (!call || ["completed", "missed", "failed", "canceled"].includes(call.status)) return;

  if (call.routing && payload.call_control_id !== call.providerCallControlId) {
    if (clientState?.kind !== 'agent-leg' || clientState.revision !== call.routing.revision) return;
    if (call.status !== 'in-progress') {
      await ivrAgentFailed(call, ivrCallbacks);
      return;
    }
  }

  if (call.routing) {
    const final = await CallLog.findOneAndUpdate({ _id: call._id, status: call.status, 'routing.revision': call.routing.revision }, {
      $set: {
        status: call.status === 'in-progress' ? 'completed' : 'canceled', endedAt: new Date(), hangupCause: cause,
        'routing.stage': 'terminal', 'routing.deadline': null,
        ...(call.answeredAt ? { durationSec: Math.max(0, Math.round((Date.now() - call.answeredAt.getTime()) / 1000)) } : {}),
      },
    }, { new: true });
    clearIvrTimer(String(call._id));
    if (final) emitIvrCall(final);
    return;
  }

  const ended = new Date();
  let status: string;
  if (call.status === "in-progress") status = "completed";
  else if (call.status === "ringing") status = "canceled"; // caller gave up
  else status = cause === "normal_clearing" ? "completed" : "missed"; // answering

  call.status = status as any;
  call.endedAt = ended;
  call.hangupCause = cause;
  if (call.answeredAt) {
    call.durationSec = Math.max(0, Math.round((ended.getTime() - call.answeredAt.getTime()) / 1000));
  }
  await call.save();

  const timer = ringTimers.get(String(call._id));
  if (timer) {
    clearTimeout(timer);
    ringTimers.delete(String(call._id));
  }

  emitToOrg(call.orgId, "comm:call:update", { call: call.toObject() });

  if (status === "missed") {
    const claimed = await CallLog.findOneAndUpdate(
      { _id: call._id, textBackSentAt: null },
      { $set: { textBackSentAt: new Date() } },
      { new: true }
    );
    if (claimed) await sendMissedCallTextBack(claimed);
  }
}

/** call.speak.ended — used by the missed-call announcement; hang up after. */
export async function handleSpeakEnded(payload: any) {
  const id = payload?.call_control_id;
  const tag = decodeClientState(payload?.client_state);
  const call = id ? await CallLog.findOne({ providerCallControlId: id }) : null;
  if (call?.routing || String(tag?.kind || '').startsWith('ivr-')) {
    if (call?.status === 'missed') await telnyx.hangupCall(id).catch(() => {});
    return;
  }
  if (id) await telnyx.hangupCall(id).catch(() => {});
}

/* ------------------------------ voice: outbound -------------------------- */
/** Outbound calls originate in the BROWSER via TelnyxRTC (credential
 *  connection), so the frontend reports lifecycle events for logging.
 *  All updates are idempotent by clientCallId. */
export async function logClientCall(opts: {
  orgId: any;
  user: IActorRef;
  clientCallId: string;
  event: "start" | "answered" | "end" | "failed";
  toPhone?: string;
  customerId?: any;
  leadId?: any;
  hangupCause?: string;
}) {
  if (opts.event === "start") {
    const to = normalizePhone(opts.toPhone || "");
    let customerId = opts.customerId ?? null;
    let customerName: string | undefined;
    let leadId = opts.leadId ?? null;
    if (!customerId) {
      const c = await findCustomerByPhone(opts.orgId, to);
      if (c) {
        customerId = c._id;
        customerName = customerDisplayName(c);
      }
    }
    if (!leadId) {
      const lead = await findLeadByPhone(opts.orgId, to);
      if (lead) leadId = lead._id;
    }
    const conversation = await getOrCreateConversation({
      orgId: opts.orgId,
      phone: to,
      customerId,
      customerName,
      leadId,
    });
    const call = await CallLog.findOneAndUpdate(
      { clientCallId: opts.clientCallId },
      {
        $setOnInsert: {
          orgId: opts.orgId,
          customerId,
          leadId,
          conversationId: conversation._id,
          direction: "outbound",
          from: telnyx.COMPANY_NUMBER,
          to,
          status: "ringing",
          placedBy: opts.user,
          startedAt: new Date(),
          customerName,
          clientCallId: opts.clientCallId,
        },
      },
      { new: true, upsert: true }
    );
    emitToOrg(opts.orgId, "comm:call:update", { call: call.toObject() });
    return call;
  }

  const call = await CallLog.findOne({ clientCallId: opts.clientCallId, orgId: opts.orgId });
  if (!call) return null;

  if (opts.event === "answered" && call.status === "ringing") {
    call.status = "in-progress" as any;
    call.answeredAt = new Date();
  } else if (opts.event === "end" && !["completed", "failed", "canceled"].includes(call.status)) {
    const ended = new Date();
    call.endedAt = ended;
    if (call.answeredAt) {
      call.status = "completed" as any;
      call.durationSec = Math.max(0, Math.round((ended.getTime() - call.answeredAt.getTime()) / 1000));
    } else {
      call.status = "canceled" as any;
    }
    if (opts.hangupCause) call.hangupCause = opts.hangupCause;
  } else if (opts.event === "failed") {
    call.status = "failed" as any;
    call.endedAt = new Date();
    if (opts.hangupCause) call.hangupCause = opts.hangupCause;
  } else {
    return call;
  }

  await call.save();
  emitToOrg(opts.orgId, "comm:call:update", { call: call.toObject() });
  return call;
}

/* ----------------------------- WebRTC tokens ---------------------------- */

export async function getRtcToken(user: IActorRef) {
  let cred = await TelephonyCredential.findOne({ userId: user.userId });
  if (!cred) {
    const created = await telnyx.createTelephonyCredential(
      `suprah-${user.email || user.userId}`
    );
    cred = await TelephonyCredential.findOneAndUpdate(
      { userId: user.userId },
      { $set: { credentialId: created.id, sipUsername: created.sip_username } },
      { new: true, upsert: true }
    );
  }
  const token = await telnyx.createRtcLoginToken(cred!.credentialId);
  return { token, sipUsername: cred!.sipUsername, callerNumber: telnyx.COMPANY_NUMBER };
}

/* ------------------------- thread lookup (leads UI) ---------------------- */

export async function getThreadByPhone(orgId: any, phone: string, leadId?: string) {
  const customerPhone = normalizePhone(phone);
  const query: any = { orgId };
  if (leadId) query.$or = [{ customerPhone }, { leadId }];
  else query.customerPhone = customerPhone;

  const conversation: any = await Conversation.findOne(query)
    .sort({ lastMessageAt: -1 })
    .lean();
  if (!conversation) return { conversation: null, messages: [] };

  const messages = await CommunicationMessage.find({ conversationId: conversation._id })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const withFailureInfo = messages.map((message: any) => {
    if (message.status !== "failed" || !message.errorDetail) return message;
    const failure = describeSmsFailure(message.errorDetail);
    if (!failure) return message;
    return { ...message, smsFailureMessage: failure.friendlyMessage, smsFailureCategory: failure.category };
  });
  return { conversation, messages: withFailureInfo.reverse() };
}

/** CustomerRecord-shaped lookup for the calls workspace info panel. */
export async function lookupCallerRecord(orgId: any, phone: string) {
  const normalized = normalizePhone(phone);
  const [customer, lead, previousCalls]: [any, any, any[]] = await Promise.all([
    findCustomerByPhone(orgId, normalized),
    findLeadByPhone(orgId, normalized),
    CallLog.find({
      orgId,
      $or: [{ from: normalized }, { to: normalized }],
      status: { $in: ["completed", "missed"] },
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
  ]);

  if (!customer && !lead) return null;
  const source: any = customer || lead;
  return {
    id: String(source._id),
    name:
      customerDisplayName(customer) ||
      `${source.firstName || ""} ${source.lastName || ""}`.trim() ||
      normalized,
    email: source.email || undefined,
    phone: normalized,
    accountStatus: customer ? "active" : "new",
    previousCalls: previousCalls.map((c: any) => ({
      date: c.createdAt,
      duration: c.durationSec || 0,
      notes: c.status === "missed" ? "Missed call" : undefined,
    })),
    leadId: lead ? String(lead._id) : undefined,
    isLead: !customer && !!lead,
  };
}

/* --------------------------------- utils -------------------------------- */

function decodeClientState(cs?: string): any {
  if (!cs) return null;
  try {
    return JSON.parse(Buffer.from(cs, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
import { findUniqueCustomerByPhone } from './customerIdentity.service';
import { normalizeIdentityPhone } from '../utils/contactIdentity';
