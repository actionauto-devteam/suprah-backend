import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { SIGN_IN_AGAIN } from "../utils/userMessages";
import { parseClientRequestId } from "../utils/clientRequestId";
import type { IUser } from "../models/User.model";
import {
  listChatMessages,
  markChatRead,
  resolveCustomerChat,
  resolveLoadChat,
  sendChatMessage,
  setDispatcherChatClosed,
  shipmentChatView,
  type ShipmentChatContext,
} from "../services/shipmentChat.service";
import { listCustomerChatInbox } from "../services/shipmentChatInbox.service";

/*
 * Customer chats on a shipment (see services/shipmentChat.service.ts).
 * Customers reach them from My Shipments by shipment (quote) id and chat
 * ("driver" or "dispatcher"); the load's driver and dispatcher reach them
 * from the load. Every handler works out who's in the chat from the load as
 * it is now.
 */

const signedInUser = (req: Request): IUser => {
  const user = req.user as IUser | undefined;
  if (!user?._id) throw new ApiError(401, SIGN_IN_AGAIN);
  return user;
};

const customerChat = (req: Request) => resolveCustomerChat(String(signedInUser(req)._id), req.params.id, req.params.kind);
const loadChat = (req: Request) => resolveLoadChat(signedInUser(req), req.orgId, req.params.loadId);

async function chatWithMessages(ctx: ShipmentChatContext, before: unknown) {
  const [chat, page] = await Promise.all([shipmentChatView(ctx), listChatMessages(ctx, before)]);
  return { chat, ...page };
}

const sendFrom = (resolve: (req: Request) => Promise<ShipmentChatContext>, withPhotos: boolean) =>
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await resolve(req);
    const files = withPhotos ? ((req.files || []) as Express.Multer.File[]) : [];
    if (withPhotos && files.length === 0) throw new ApiError(400, "Choose at least one photo to send.");
    const { message, repeated } = await sendChatMessage(ctx, {
      content: req.body?.content,
      clientMessageId: parseClientRequestId(req.body?.clientMessageId),
      photos: files,
    });
    const status = repeated ? 200 : 201;
    return res.status(status).json(new ApiResponse(status, message, repeated ? "Message already sent" : "Message sent"));
  });

// ─── Customer (My Shipments) ───────────────────────────────────────────────────

/** GET /api/quote-requests/:id/chats/:kind — the chat and its latest messages (?before= for older ones). */
const getCustomerChat = asyncHandler(async (req: Request, res: Response) => {
  const ctx = await customerChat(req);
  return res.status(200).json(new ApiResponse(200, await chatWithMessages(ctx, req.query.before), "Shipment chat"));
});

/** POST /api/quote-requests/:id/chats/:kind/messages */
const sendCustomerMessage = sendFrom(customerChat, false);

/** POST /api/quote-requests/:id/chats/:kind/photos (multipart "photos", optional "content") */
const sendCustomerPhotos = sendFrom(customerChat, true);

/** POST /api/quote-requests/:id/chats/:kind/read */
const markCustomerChatRead = asyncHandler(async (req: Request, res: Response) => {
  const ctx = await customerChat(req);
  return res.status(200).json(new ApiResponse(200, await markChatRead(ctx, req.body?.readUpTo), "Chat marked read"));
});

// ─── Driver and dispatcher (by load) ───────────────────────────────────────────

/** GET /api/driver-tracking/loads/:loadId/customer-chat — whether there's a chat, and unread messages. */
const getLoadChat = asyncHandler(async (req: Request, res: Response) => {
  const ctx = await loadChat(req);
  return res.status(200).json(new ApiResponse(200, await shipmentChatView(ctx), "Customer chat"));
});

/** GET /api/driver-tracking/loads/:loadId/customer-chat/messages (?before= for older ones) */
const getLoadChatMessages = asyncHandler(async (req: Request, res: Response) => {
  const ctx = await loadChat(req);
  return res.status(200).json(new ApiResponse(200, await chatWithMessages(ctx, req.query.before), "Customer chat"));
});

/** POST /api/driver-tracking/loads/:loadId/customer-chat/messages */
const sendLoadMessage = sendFrom(loadChat, false);

/** POST /api/driver-tracking/loads/:loadId/customer-chat/photos */
const sendLoadPhotos = sendFrom(loadChat, true);

/** POST /api/driver-tracking/loads/:loadId/customer-chat/read */
const markLoadChatRead = asyncHandler(async (req: Request, res: Response) => {
  const ctx = await loadChat(req);
  return res.status(200).json(new ApiResponse(200, await markChatRead(ctx, req.body?.readUpTo), "Chat marked read"));
});

/** GET /api/driver-tracking/customer-chats — Dispatch Chat's Customers section: my customer chats, newest first. */
const getCustomerChatInbox = asyncHandler(async (req: Request, res: Response) => {
  const inbox = await listCustomerChatInbox(signedInUser(req), req.orgId);
  return res.status(200).json(new ApiResponse(200, inbox, "Customer chats"));
});

/** POST /api/driver-tracking/loads/:loadId/customer-chat/close and /reopen (the dispatcher) */
const setLoadChatClosed = (close: boolean) =>
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await loadChat(req);
    await setDispatcherChatClosed(ctx, close);
    const view = await shipmentChatView(await loadChat(req));
    return res.status(200).json(new ApiResponse(200, view, close ? "Chat closed" : "Chat reopened"));
  });

export default {
  getCustomerChat,
  sendCustomerMessage,
  sendCustomerPhotos,
  markCustomerChatRead,
  getLoadChat,
  getLoadChatMessages,
  sendLoadMessage,
  sendLoadPhotos,
  markLoadChatRead,
  getCustomerChatInbox,
  closeLoadChat: setLoadChatClosed(true),
  reopenLoadChat: setLoadChatClosed(false),
};
