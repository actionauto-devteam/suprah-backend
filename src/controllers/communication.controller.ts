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

  const convQuery: any = { orgId, $or: [{ customerId }] };
  if (phone) convQuery.$or.push({ customerPhone: phone });

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
      ],
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean(),
  ]);

  res.json(new ApiResponse(200, { conversation, messages, calls }, "Customer thread"));
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
  const { clientCallId, event, toPhone, customerId, hangupCause } = req.body || {};
  if (!clientCallId || !event) throw new ApiError(400, "clientCallId and event are required");

  const call = await comm.logClientCall({
    orgId,
    user: actor(req),
    clientCallId,
    event,
    toPhone,
    customerId,
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
