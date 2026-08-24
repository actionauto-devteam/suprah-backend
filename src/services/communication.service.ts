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

function buildMissedCallMessage(dealerName: string): string {
  return `Thank you for calling ${dealerName}. All of our team members are currently unavailable. Please send us a text message and we will get back to you as soon as possible.`;
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
export async function handleInboundSms(payload: any) {
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
  const orgId = await resolveOrgForNumber(to);
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
      { $set: { status: "missed", endedAt: new Date() } },
      { new: true }
    );
    if (still) {
      emitToOrg(orgId, "comm:call:update", { call: still.toObject() });
      const dealerName = await resolveDealerName(orgId);
      await telnyx.playMissedAndHangup(callControlId, buildMissedCallMessage(dealerName)).catch(() => {});
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
  hangupCause?: string;
}) {
  if (opts.event === "start") {
    const to = normalizePhone(opts.toPhone || "");
    let customerId = opts.customerId ?? null;
    let customerName: string | undefined;
    if (!customerId) {
      const c = await findCustomerByPhone(opts.orgId, to);
      if (c) {
        customerId = c._id;
        customerName = customerDisplayName(c);
      }
    }
    const conversation = await getOrCreateConversation({
      orgId: opts.orgId,
      phone: to,
      customerId,
      customerName,
    });
    const call = await CallLog.findOneAndUpdate(
      { clientCallId: opts.clientCallId },
      {
        $setOnInsert: {
          orgId: opts.orgId,
          customerId,
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
