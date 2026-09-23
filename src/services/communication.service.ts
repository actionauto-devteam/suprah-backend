import mongoose from "mongoose";
import {
  Conversation,
  CommunicationMessage,
  CallLog,
  TelephonyCredential,
  IActorRef,
} from "../models/communication.model";
import * as telnyx from "./telnyx.service";
import { getSocketIO } from "../utils/socketEmitter";
import Organization from "../models/Organization.model";
import Appointment from "../models/Appointment.model";
import { notifyOrgAdmins } from "../utils/safeNotification";
import { notificationTemplates } from "../utils/notificationTemplates";
import { CALENDAR_TZ } from "../constants/calendarTimezone";
import SmsOptOut from "../models/SmsOptOut.model";
import Vehicle from "../models/Vehicle.model";

/** Emit through the platform's existing Socket.io instance (same one the
 *  lead:new / lead:update events use). Payload always carries orgId so the
 *  client-side store can filter. */
function emitToOrg(orgId: any, event: string, payload: any) {
  try {
    const io = getSocketIO();
    if (!io) return;
    io.emit(event, { ...payload, orgId: String(orgId) });
  } catch {
    /* socket emission must never break a request or webhook */
  }
}

const RING_TIMEOUT_MS = 35_000;

/** Resolve the tenant dealership's display name for voice/SMS copy. */
async function resolveDealerName(organizationId: any): Promise<string> {
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
}): Promise<boolean> {
  if (await isSmsOptedOut(opts.orgId, opts.toPhone)) return false;
  const { actor, ...rest } = opts;
  await sendSmsFromUser({ ...rest, user: actor });
  return true;
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
const CUSTOMER_PHONE_FIELDS = ["phoneNumber", "phone", "mobile", "contactNumber", "cellPhone"];

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
  const tail = last10(phone);
  if (tail.length < 7) return null;

  let CustomerModel: mongoose.Model<any> | null = null;
  try {
    CustomerModel = mongoose.model("Customer");
  } catch {
    return null; // Customer model not registered — threads still work by phone
  }

  const or = CUSTOMER_PHONE_FIELDS.map((f) => ({
    [f]: { $regex: `${tail}$` },
  }));

  // Try org-scoped first, fall back to unscoped in case the Customer schema
  // uses a different org field name.
  const scoped: any = await CustomerModel.findOne({ orgId, $or: or })
    .lean()
    .catch(() => null);
  if (scoped) return scoped;
  const unscoped: any = await CustomerModel.findOne({ $or: or })
    .lean()
    .catch(() => null);
  return unscoped;
}

/** Match an inbound phone number to an existing Lead (leads page workflow).
 *  Lead model uses `organizationId` + `phone`. */
export async function findLeadByPhone(orgId: any, phone: string): Promise<any | null> {
  const tail = last10(phone);
  if (tail.length < 7) return null;
  let LeadModel: mongoose.Model<any> | null = null;
  try {
    LeadModel = mongoose.model("Lead");
  } catch {
    return null;
  }
  const lead: any = await LeadModel.findOne({
    organizationId: orgId,
    phone: { $regex: `${tail.split("").join("[^0-9]*")}$` },
  })
    .sort({ updatedAt: -1 })
    .lean()
    .catch(() => null);
  return lead;
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

async function handleAppointmentSmsReply(orgId: any, from: string, body: string): Promise<void> {
  const command = normalizeSmsCommand(body);
  const isConfirm = CONFIRM_KEYWORDS.has(command);
  const isReschedule = RESCHEDULE_KEYWORDS.has(command);
  if (!isConfirm && !isReschedule) return;

  const appointment = await findAppointmentForReply(orgId, from);
  if (!appointment) return;

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
      await sendAutomatedSms({
        orgId,
        toPhone: from,
        body: "Got it, we'll reach out shortly to find a better time.",
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
}

async function handleSmsOptCommand(orgId: any, from: string, body: string): Promise<void> {
  const command = normalizeSmsCommand(body);
  const isOptOut = OPT_OUT_KEYWORDS.has(command);
  const isOptIn = OPT_IN_KEYWORDS.has(command);
  if (!isOptOut && !isOptIn) return;

  await SmsOptOut.updateOne(
    { organizationId: String(orgId), phone: normalizePhone(from) },
    { $set: { optedOut: isOptOut, changedAt: new Date(), keyword: command } },
    { upsert: true }
  );

  if (!isOptOut) return;

  const lead = await findLeadByPhone(orgId, from);
  const customerName =
    [lead?.firstName, lead?.lastName].filter(Boolean).join(" ").trim() || normalizePhone(from);
  const { title, message } = notificationTemplates.sms_opt_out({ customerName, keyword: command });
  await notifyOrgAdmins(String(orgId), "sms_opt_out", title, message, {
    leadId: lead?._id ? String(lead._id) : undefined,
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

const NURTURE_MESSAGES: Array<(dealerName: string, firstName: string, subject: string) => string> = [
  (dealerName, firstName, subject) =>
    `Hi ${firstName}, ${dealerName} here. Just checking in on ${subject}. Do you have any questions I can help with? Reply anytime. Reply STOP to opt out.`,
  (dealerName, firstName, subject) =>
    `Hi ${firstName}, this is ${dealerName}. Would you like to set up a time to see ${subject} in person? Reply with a day that works for you and we'll get it scheduled. Reply STOP to opt out.`,
  (dealerName, firstName, subject) =>
    `Hi ${firstName}, ${dealerName} here. This is my last check-in on ${subject}. If you're still interested, just reply and we'll take it from there. No worries if not! Reply STOP to opt out.`,
];

export async function sendLeadNurtureText(lead: any, step: number): Promise<boolean> {
  if (!lead.phone) return false;

  const firstName = lead.firstName?.trim() || "there";
  const dealerName = await resolveDealerName(lead.organizationId);
  const vehicleLabel = [lead.vehicle?.year, lead.vehicle?.make, lead.vehicle?.model]
    .filter(Boolean)
    .join(" ");
  const subject = vehicleLabel ? `the ${vehicleLabel}` : "the vehicle you asked about";
  const buildMessage = NURTURE_MESSAGES[Math.min(step, NURTURE_MESSAGES.length - 1)];

  return sendAutomatedSms({
    orgId: lead.organizationId,
    toPhone: lead.phone,
    body: buildMessage(dealerName, firstName, subject),
    leadId: lead._id,
  });
}

function buildReviewRequestMessage(dealerName: string, firstName: string, reviewLink: string | null): string {
  return reviewLink
    ? `Hi ${firstName}, thanks for choosing ${dealerName}! If you have a minute, we'd really appreciate a quick review: ${reviewLink} Reply STOP to opt out.`
    : `Hi ${firstName}, thanks for choosing ${dealerName}! We'd love to hear how it went — reply and let us know. Reply STOP to opt out.`;
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
    body: buildReviewRequestMessage(dealerName, firstName, reviewLink),
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
async function touchLeadOnInbound(leadId: any) {
  try {
    const LeadModel = mongoose.model("Lead");
    await LeadModel.updateOne(
      { _id: leadId },
      {
        $set: {
          "followUp.lastCustomerActivityAt": new Date(),
          isRead: false,
        },
      }
    );
    const io = getSocketIO();
    if (io) io.emit("lead:update", { leadId: String(leadId) });
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

/* --------------------------------- SMS ---------------------------------- */

export async function sendSmsFromUser(opts: {
  orgId: any;
  user: IActorRef;
  toPhone: string;
  body: string;
  customerId?: any;
  customerName?: string;
  leadId?: any;
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
    const sent = await telnyx.sendSms(to, body);
    message.providerMessageId = sent.id;
    message.status = "sent";
    message.sentAt = new Date();
    await message.save();
  } catch (err: any) {
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

/** Inbound SMS from Telnyx webhook (message.received). */
export async function handleInboundSms(payload: any, orgOverride?: any) {
  const from = normalizePhone(payload?.from?.phone_number || payload?.from || "");
  const toEntry = Array.isArray(payload?.to) ? payload.to[0] : payload?.to;
  const to = normalizePhone(toEntry?.phone_number || toEntry || telnyx.COMPANY_NUMBER);
  const body = payload?.text || "";
  const providerMessageId = payload?.id;

  if (!from || !body) return null;

  // Idempotency — Telnyx retries webhooks.
  if (providerMessageId) {
    const dupe = await CommunicationMessage.findOne({ providerMessageId }).lean();
    if (dupe) return dupe;
  }

  // Which org owns this number? Single-number setup: resolve org from env or
  // the first conversation. For a single-org deployment set COMM_ORG_ID.
  const orgId = orgOverride ?? (await resolveOrgForNumber(to));
  if (!orgId) {
    console.error("[comm] inbound SMS but COMM_ORG_ID is not configured");
    return null;
  }

  const customer = await findCustomerByPhone(orgId, from);
  const lead = await findLeadByPhone(orgId, from);
  const conversation = await getOrCreateConversation({
    orgId,
    phone: from,
    customerId: customer?._id,
    customerName:
      customerDisplayName(customer) ||
      (lead ? `${lead.firstName || ""} ${lead.lastName || ""}`.trim() || undefined : undefined),
    leadId: lead?._id,
  });

  const message = await CommunicationMessage.create({
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
  if (lead?._id) await touchLeadOnInbound(lead._id);
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

  await handleSmsOptCommand(orgId, from, body).catch((err) => {
    console.error("[comm] handleSmsOptCommand failed:", err);
  });

  await handleAppointmentSmsReply(orgId, from, body).catch((err) => {
    console.error("[comm] handleAppointmentSmsReply failed:", err);
  });

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

/** call.initiated webhook. Fresh inbound calls create a ringing CallLog and
 *  broadcast to every online agent. Agent legs (tagged via client_state) and
 *  our own outbound Call Control legs are ignored here. */
export async function handleCallInitiated(payload: any) {
  const direction = payload?.direction; // "incoming" | "outgoing"
  const clientState = decodeClientState(payload?.client_state);
  if (direction !== "incoming" || clientState?.kind === "agent-leg") return;

  const callControlId = payload?.call_control_id;
  const callSessionId = payload?.call_session_id;
  const from = normalizePhone(payload?.from || "");
  const to = normalizePhone(payload?.to || telnyx.COMPANY_NUMBER);

  // Idempotency
  const existing = await CallLog.findOne({ providerCallControlId: callControlId }).lean();
  if (existing) return;

  const orgId = await resolveOrgForNumber(to);
  if (!orgId) return;

  const customer = await findCustomerByPhone(orgId, from);
  const lead = await findLeadByPhone(orgId, from);
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

  const call = await CallLog.create({
    orgId,
    customerId: customer?._id ?? null,
    leadId: lead?._id ?? null,
    conversationId: conversation._id,
    direction: "inbound",
    from,
    to,
    status: "ringing",
    providerCallControlId: callControlId,
    providerCallSessionId: callSessionId,
    startedAt: new Date(),
    customerName: displayName,
  });

  emitToOrg(orgId, "comm:call:incoming", { call: call.toObject() });

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
  const call = await CallLog.findOneAndUpdate(
    { _id: opts.callId, orgId: opts.orgId, status: "ringing" },
    { $set: { status: "answering", answeredBy: opts.user } },
    { new: true }
  );
  if (!call) {
    throw Object.assign(new Error("Call already answered or ended"), { statusCode: 409 });
  }

  const timer = ringTimers.get(String(call._id));
  if (timer) {
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
    });
  } catch (err: any) {
    await CallLog.updateOne(
      { _id: call._id },
      { $set: { status: "failed", hangupCause: String(err?.message).slice(0, 200), endedAt: new Date() } }
    );
    const failed = await CallLog.findById(call._id);
    if (failed) emitToOrg(opts.orgId, "comm:call:update", { call: failed.toObject() });
    throw Object.assign(new Error("Could not bridge the call"), { statusCode: 502 });
  }

  emitToOrg(opts.orgId, "comm:call:update", { call: call.toObject() });
  return call;
}

/** call.answered — the agent leg picked up → call is live. */
export async function handleCallAnswered(payload: any) {
  const clientState = decodeClientState(payload?.client_state);
  const sessionId = payload?.call_session_id;

  const query = clientState?.callLogId
    ? { _id: clientState.callLogId }
    : { providerCallSessionId: sessionId };

  const call = await CallLog.findOneAndUpdate(
    { ...query, status: { $in: ["ringing", "answering"] } },
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
  if (call) emitToOrg(call.orgId, "comm:call:update", { call: call.toObject() });
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
  return { conversation, messages: messages.reverse() };
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
