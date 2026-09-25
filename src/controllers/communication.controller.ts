import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import {
  Conversation,
  CommunicationMessage,
  CallLog,
} from "../models/communication.model";
import * as comm from "../services/communication.service";
import * as telnyx from "../services/telnyx.service";
import Lead from "../models/lead.model";
import Appointment from "../models/Appointment.model";
import WebChatMessage from "../models/WebChatMessage.model";
import MailConversation from "../models/MailConversation.model";
import MailMessage from "../models/MailMessage.model";

/** crmAuth() attaches req.user or req.crmUser plus req.orgId (same pattern
 *  as lead.controller). */
function actor(req: Request) {
  const u: any = (req as any).user || (req as any).crmUser || {};
  return {
    userId: u._id || u.id || u.userId,
    name:
      u.name ||
      [u.firstName, u.lastName].filter(Boolean).join(" ") ||
      u.email ||
      "Team member",
    email: u.email,
  };
}
const orgOf = (req: Request) => (req as any).orgId;

/* ------------------------------ conversations --------------------------- */

export const listConversations = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || "20"), 10)));

  const [items, total] = await Promise.all([
    Conversation.find({ orgId })
      .sort({ lastMessageAt: -1, updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Conversation.countDocuments({ orgId }),
  ]);

  res.json(new ApiResponse(200, { items, total, page, limit }, "Conversations"));
});

export const getConversationMessages = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const { id } = req.params;
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10)));
  const before = req.query.before ? new Date(String(req.query.before)) : null;

  const conversation = await Conversation.findOne({ _id: id, orgId }).lean();
  if (!conversation) throw new ApiError(404, "Conversation not found");

  const query: any = { conversationId: id, orgId };
  if (before && !isNaN(before.getTime())) query.createdAt = { $lt: before };

  const messages = await CommunicationMessage.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  res.json(
    new ApiResponse(
      200,
      { conversation, messages: messages.reverse(), hasMore: messages.length === limit },
      "Messages"
    )
  );
});

/** Reply inside an existing conversation. */
export const replyToConversation = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const { id } = req.params;
  const { body } = req.body || {};

  const conversation = await Conversation.findOne({ _id: id, orgId });
  if (!conversation) throw new ApiError(404, "Conversation not found");

  const result = await comm.sendSmsFromUser({
    orgId,
    user: actor(req),
    toPhone: conversation.customerPhone,
    body,
    customerId: conversation.customerId,
    customerName: conversation.customerName,
  });

  res.status(201).json(new ApiResponse(201, { message: result.message }, "Message sent"));
});

/** Start (or continue) a thread by phone/customer/lead — used by the leads
 *  page SMS Reply and the customer profile. */
export const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const { toPhone, body, customerId, customerName, leadId } = req.body || {};
  if (!toPhone) throw new ApiError(400, "toPhone is required");

  const result = await comm.sendSmsFromUser({
    orgId,
    user: actor(req),
    toPhone,
    body,
    customerId,
    customerName,
    leadId,
  });

  res
    .status(201)
    .json(
      new ApiResponse(
        201,
        { message: result.message, conversationId: result.conversation._id },
        "Message sent"
      )
    );
});

/** Everything for one customer's profile widget: thread + calls, shared org-wide. */
export const getCustomerThread = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const { customerId } = req.params;
  const phone = req.query.phone ? comm.normalizePhone(String(req.query.phone)) : null;
  const leadId = req.query.leadId ? String(req.query.leadId) : null;

  const convQuery: any = { orgId, $or: [{ customerId }] };
  if (phone) convQuery.$or.push({ customerPhone: phone });
  if (leadId) convQuery.$or.push({ leadId });

  const conversation = await Conversation.findOne(convQuery).sort({ lastMessageAt: -1 });

  const [messages, calls] = await Promise.all([
    conversation
      ? CommunicationMessage.find({ conversationId: conversation._id })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean()
          .then((m) => m.reverse())
      : Promise.resolve([]),
    CallLog.find({
      orgId,
      $or: [
        { customerId },
        ...(phone ? [{ from: phone }, { to: phone }] : []),
        ...(leadId ? [{ leadId }] : []),
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  res.json(new ApiResponse(200, { conversation, messages, calls }, "Customer thread"));
});

type TimelineChannel = "sms" | "call" | "email" | "webchat" | "appointment" | "note";

interface TimelineItem {
  id: string;
  channel: TimelineChannel;
  direction?: "inbound" | "outbound" | "system";
  title: string;
  body?: string;
  status?: string;
  actor?: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}

export const getLeadTimeline = asyncHandler(async (req: Request, res: Response) => {
  const orgId = String(orgOf(req));
  const { leadId } = req.params;
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "30"), 10)));
  let cursor: { occurredAt: Date; id: string } | null = null;
  if (req.query.before) {
    try {
      const parsed = JSON.parse(Buffer.from(String(req.query.before), "base64url").toString("utf8"));
      const occurredAt = new Date(parsed.occurredAt);
      if (!isNaN(occurredAt.getTime()) && typeof parsed.id === "string") cursor = { occurredAt, id: parsed.id };
    } catch {
      const occurredAt = new Date(String(req.query.before));
      if (!isNaN(occurredAt.getTime())) cursor = { occurredAt, id: "" };
    }
  }
  const beforeDate = cursor?.occurredAt || null;

  const lead: any = await Lead.findOne({ _id: leadId, organizationId: orgId })
    .select("firstName lastName email phone channel source subject body parsedContent comments notes statusHistory createdAt")
    .lean();
  if (!lead) throw new ApiError(404, "Lead not found");

  const phone = lead.phone ? comm.normalizePhone(String(lead.phone)) : null;
  const conversationQuery: any = { orgId, $or: [{ leadId }] };
  if (phone) conversationQuery.$or.push({ customerPhone: phone });
  const conversations = await Conversation.find(conversationQuery).select("_id").lean();
  const conversationIds = conversations.map((item: any) => item._id);
  const timeFilter = beforeDate ? { $lte: beforeDate } : undefined;
  const sourceLimit = Math.min(250, limit * 3);
  const unavailableSources: string[] = [];

  const safe = async <T>(name: string, load: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await load();
    } catch {
      unavailableSources.push(name);
      return fallback;
    }
  };

  const messageOr: any[] = [{ leadId }];
  if (conversationIds.length) messageOr.push({ conversationId: { $in: conversationIds } });
  const callOr: any[] = [{ leadId }];
  if (phone) callOr.push({ from: phone }, { to: phone });

  const [messages, calls, webchat, appointments, mailConversations] = await Promise.all([
    safe("sms", () => CommunicationMessage.find({
      orgId,
      $or: messageOr,
      ...(timeFilter ? { createdAt: timeFilter } : {}),
    }).sort({ createdAt: -1, _id: -1 }).limit(sourceLimit).lean(), []),
    safe("call", () => CallLog.find({
      orgId,
      $or: callOr,
      ...(timeFilter ? { createdAt: timeFilter } : {}),
    }).sort({ createdAt: -1, _id: -1 }).limit(sourceLimit).lean(), []),
    safe("webchat", () => WebChatMessage.find({
      organizationId: orgId,
      leadId,
      ...(timeFilter ? { createdAt: timeFilter } : {}),
    }).sort({ createdAt: -1, _id: -1 }).limit(sourceLimit).lean(), []),
    safe("appointment", () => Appointment.find({
      organizationId: orgId,
      leadId,
    }).sort({ updatedAt: -1, _id: -1 }).limit(sourceLimit).lean(), []),
    lead.email
      ? safe("email", () => MailConversation.find({
          organizationId: orgId,
          "participants.email": String(lead.email).toLowerCase(),
        }).select("_id").lean(), [])
      : Promise.resolve([]),
  ]);

  const mailConversationIds = (mailConversations as any[]).map((item) => item._id);
  const emails: any[] = mailConversationIds.length
    ? await safe("email", () => MailMessage.find({
        organizationId: orgId,
        conversationId: { $in: mailConversationIds },
        ...(timeFilter ? { sentAt: timeFilter } : {}),
      }).sort({ sentAt: -1, _id: -1 }).limit(sourceLimit).lean(), [])
    : [];

  const items: TimelineItem[] = [];

  for (const message of messages as any[]) {
    items.push({
      id: `sms:${message._id}`,
      channel: "sms",
      direction: message.direction,
      title: message.direction === "inbound" ? "Text received" : "Text sent",
      body: message.body,
      status: message.status,
      actor: message.direction === "inbound" ? `${lead.firstName} ${lead.lastName || ""}`.trim() : message.sentBy?.name || "Team member",
      occurredAt: message.createdAt,
      metadata: message.errorDetail ? { error: message.errorDetail } : undefined,
    });
  }

  for (const call of calls as any[]) {
    const actor = call.direction === "inbound" ? `${lead.firstName} ${lead.lastName || ""}`.trim() : call.placedBy?.name || "Team member";
    items.push({
      id: `call:${call._id}`,
      channel: "call",
      direction: call.direction,
      title: call.direction === "inbound" ? "Inbound call" : "Outbound call",
      body: call.durationSec ? `${Math.floor(call.durationSec / 60)}m ${call.durationSec % 60}s` : undefined,
      status: call.status,
      actor,
      occurredAt: call.createdAt,
      metadata: call.hangupCause ? { hangupCause: call.hangupCause } : undefined,
    });
  }

  for (const message of webchat as any[]) {
    items.push({
      id: `webchat:${message._id}`,
      channel: "webchat",
      direction: message.direction,
      title: message.direction === "inbound" ? "Web chat received" : "Web chat sent",
      body: message.body,
      status: "sent",
      actor: message.direction === "inbound" ? `${lead.firstName} ${lead.lastName || ""}`.trim() : message.sentBy?.name || "Team member",
      occurredAt: message.createdAt,
    });
  }

  for (const message of emails) {
    items.push({
      id: `email:${message._id}`,
      channel: "email",
      direction: message.direction,
      title: message.direction === "inbound" ? "Email received" : "Email sent",
      body: message.bodyText,
      status: message.status,
      actor: message.direction === "inbound" ? message.fromName || message.fromEmail : "Team member",
      occurredAt: message.sentAt || message.createdAt,
      metadata: message.errorMessage ? { error: message.errorMessage } : undefined,
    });
  }

  for (const appointment of appointments as any[]) {
    items.push({
      id: `appointment:${appointment._id}:created`,
      channel: "appointment",
      direction: "system",
      title: "Appointment scheduled",
      body: appointment.notes || appointment.title,
      status: "scheduled",
      actor: "System",
      occurredAt: appointment.createdAt,
      metadata: { appointmentId: String(appointment._id), startTime: appointment.startTime },
    });
    if (appointment.statusHistory?.length) {
      for (const history of appointment.statusHistory) {
        items.push({
          id: `appointment:${appointment._id}:status:${history._id || new Date(history.changedAt).getTime()}`,
          channel: "appointment",
          direction: "system",
          title: `Appointment ${history.to}`,
          body: history.to === appointment.status ? appointment.outcomeNotes : undefined,
          status: history.to,
          actor: history.actorName || "Team member",
          occurredAt: history.changedAt,
          metadata: { appointmentId: String(appointment._id), from: history.from, to: history.to },
        });
      }
    } else if (appointment.status !== "scheduled") {
      items.push({
        id: `appointment:${appointment._id}:current`,
        channel: "appointment",
        direction: "system",
        title: `Appointment ${appointment.status}`,
        body: appointment.outcomeNotes,
        status: appointment.status,
        actor: "System",
        occurredAt: appointment.updatedAt,
        metadata: { appointmentId: String(appointment._id), startTime: appointment.startTime },
      });
    }
  }

  for (const note of lead.notes || []) {
    items.push({
      id: `note:${note._id || new Date(note.createdAt).getTime()}`,
      channel: "note",
      direction: "system",
      title: "Internal note",
      body: note.text,
      actor: "Team member",
      occurredAt: note.createdAt,
    });
  }

  for (const history of lead.statusHistory || []) {
    items.push({
      id: `lead-status:${history._id || new Date(history.changedAt).getTime()}`,
      channel: "appointment",
      direction: "system",
      title: `Lead moved to ${history.to}`,
      body: history.reason,
      status: history.to,
      actor: "Team member",
      occurredAt: history.changedAt,
    });
  }

  const leadCreatedAt = new Date(lead.createdAt);
  if (!beforeDate || leadCreatedAt < beforeDate) {
    items.push({
      id: `lead:${leadId}:created`,
      channel: lead.channel === "webchat" ? "webchat" : lead.channel === "email" || lead.channel === "adf" ? "email" : "note",
      direction: "inbound",
      title: `Lead received from ${lead.source || lead.channel}`,
      body: lead.parsedContent || lead.comments || lead.body,
      actor: `${lead.firstName} ${lead.lastName || ""}`.trim(),
      occurredAt: leadCreatedAt,
      metadata: lead.subject ? { subject: lead.subject } : undefined,
    });
  }

  const sorted = items
    .filter((item) => item.occurredAt && !isNaN(new Date(item.occurredAt).getTime()))
    .filter((item) => {
      if (!cursor) return true;
      const time = new Date(item.occurredAt).getTime();
      const cursorTime = cursor.occurredAt.getTime();
      return time < cursorTime || (time === cursorTime && item.id.localeCompare(cursor.id) < 0);
    })
    .sort((a, b) => {
      const byTime = new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
      return byTime || b.id.localeCompare(a.id);
    });
  const pageItems = sorted.slice(0, limit);
  const hasMore = sorted.length > limit || [messages, calls, webchat, appointments, emails].some((source) => source.length === sourceLimit);
  const lastItem = pageItems[pageItems.length - 1];
  const nextCursor = hasMore && lastItem
    ? Buffer.from(JSON.stringify({ occurredAt: new Date(lastItem.occurredAt).toISOString(), id: lastItem.id })).toString("base64url")
    : null;

  res.json(new ApiResponse(200, {
    items: pageItems,
    nextCursor,
    hasMore,
    unavailableSources: Array.from(new Set(unavailableSources)),
  }, "Lead timeline"));
});

/** Thread by phone (leads page SMS conversations). */
export const getThreadByPhone = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const phone = String(req.query.phone || "");
  const leadId = req.query.leadId ? String(req.query.leadId) : undefined;
  if (!phone) throw new ApiError(400, "phone is required");

  const data = await comm.getThreadByPhone(orgId, phone, leadId);
  res.json(new ApiResponse(200, data, "Thread"));
});

/** Caller record for the calls workspace (customer or lead by phone). */
export const lookupCaller = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const phone = String(req.query.phone || "");
  if (!phone) throw new ApiError(400, "phone is required");

  const record = await comm.lookupCallerRecord(orgId, phone);
  res.json(new ApiResponse(200, { record }, "Caller lookup"));
});

/* --------------------------------- calls -------------------------------- */

export const listCalls = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || "20"), 10)));
  const query: any = { orgId };
  if (req.query.customerId) query.customerId = req.query.customerId;

  const [items, total] = await Promise.all([
    CallLog.find(query).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    CallLog.countDocuments(query),
  ]);

  res.json(new ApiResponse(200, { items, total, page, limit }, "Calls"));
});

/** Ringing inbound calls (page-load recovery if a socket event was missed). */
export const listRingingCalls = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const items = await CallLog.find({ orgId, status: "ringing", direction: "inbound" })
    .sort({ createdAt: -1 })
    .limit(5)
    .lean();
  res.json(new ApiResponse(200, { items }, "Ringing calls"));
});

/** First-to-answer claim; 409 if someone beat you to it. */
export const claimCall = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const { id } = req.params;
  const call = await comm.claimInboundCall({ callId: id, orgId, user: actor(req) });
  res.json(new ApiResponse(200, { call }, "Call claimed — bridging to your browser"));
});

/** Browser-originated outbound call lifecycle logging. */
export const logClientCall = asyncHandler(async (req: Request, res: Response) => {
  const orgId = orgOf(req);
  const { clientCallId, event, toPhone, customerId, leadId, hangupCause } = req.body || {};
  if (!clientCallId || !event) throw new ApiError(400, "clientCallId and event are required");

  const call = await comm.logClientCall({
    orgId,
    user: actor(req),
    clientCallId,
    event,
    toPhone,
    customerId,
    leadId,
    hangupCause,
  });
  res.json(new ApiResponse(200, { call }, "Call logged"));
});

/* ------------------------------ WebRTC token ---------------------------- */

export const getRtcToken = asyncHandler(async (req: Request, res: Response) => {
  const data = await comm.getRtcToken(actor(req));
  res.json(new ApiResponse(200, data, "RTC token"));
});

/* ------------------------------ Telnyx webhook --------------------------- */
/** PUBLIC endpoint (no crmAuth) — authenticity comes from the Ed25519
 *  signature. Requires raw body capture in app.ts (see setup guide). */
export const telnyxWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.header("telnyx-signature-ed25519") || "";
  const timestamp = req.header("telnyx-timestamp") || "";
  const rawBody: Buffer | string =
    (req as any).rawBody ?? JSON.stringify(req.body ?? {});

  if (!telnyx.verifyWebhookSignature(rawBody, signature, timestamp)) {
    // Always tell Telnyx 2xx? No — invalid signature must be rejected.
    throw new ApiError(401, "Invalid webhook signature");
  }

  const event = req.body?.data;
  const type: string = event?.event_type || "";
  const payload = event?.payload || {};

  // Respond fast; process async. Telnyx retries on non-2xx/timeouts.
  res.status(200).json({ received: true });

  try {
    switch (type) {
      case "message.received":
        await comm.handleInboundSms(payload);
        break;
      case "message.sent":
      case "message.finalized":
        await comm.handleSmsStatus(payload);
        break;
      case "call.initiated":
        await comm.handleCallInitiated(payload);
        break;
      case "call.answered":
        await comm.handleCallAnswered(payload);
        break;
      case "call.hangup":
        await comm.handleCallHangup(payload);
        break;
      case "call.speak.ended":
        await comm.handleSpeakEnded(payload);
        break;
      default:
        break; // ignore everything else
    }
  } catch (err) {
    console.error(`[comm] webhook handler error for ${type}:`, err);
  }
});
