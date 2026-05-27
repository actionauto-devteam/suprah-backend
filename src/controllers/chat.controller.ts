import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import chatService, { ChatAuthor } from "../services/chat.service";
import { emitChatEvent } from "../socket/chatSocket";
import logger from "../utils/logger";

/**
 * Resolve the acting author from the authenticated request.
 *
 * This dashboard is CRM-scoped: crmAuth() populates `req.crmUser` (NOT
 * `req.user`). We read that first, falling back to `req.user` only so the
 * controller stays reusable if mounted behind a non-CRM auth layer later.
 */
function getAuthor(req: Request): ChatAuthor {
  const crm = (req as any).crmUser;
  const u = (crm ?? (req.user as any)) as any;
  const userId = (u?._id ?? u?.id)?.toString();

  if (!userId) {
    throw new ApiError(401, "Not authenticated");
  }

  const name =
    u?.fullName || u?.name || u?.username || u?.email || "Unknown User";
  const role = u?.role || "member";
  // CrmUser docs map to the "CrmUser" model; this dashboard is CRM-scoped.
  const model: "User" | "CrmUser" = crm ? "CrmUser" : "User";
  return { userId, model, name, role };
}

/**
 * GET /api/appointments/dashboard/chat
 * List messages (newest-first), optional ?before=<id> cursor and ?limit=<n>.
 */
const getMessages = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { before, limit } = req.query;

  const result = await chatService.listMessages(orgId, {
    before: before as string | undefined,
    limit: limit ? parseInt(limit as string, 10) : undefined,
  });

  res.json(new ApiResponse(200, result, "Messages fetched successfully"));
});

/**
 * POST /api/appointments/dashboard/chat
 * Body: { content: string, replyTo?: string }
 */
const createMessage = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const author = getAuthor(req);
  const { content, replyTo } = req.body;

  const message = await chatService.createMessage(
    orgId,
    author,
    content,
    replyTo,
  );

  // Broadcast to everyone in the org room (no-op if sockets aren't wired yet).
  emitChatEvent(orgId, "chat:new", message);

  logger.info(
    { messageId: message._id, userId: author.userId, orgId },
    "Chat message created",
  );

  res.status(201).json(new ApiResponse(201, message, "Message sent"));
});

/**
 * PATCH /api/appointments/dashboard/chat/:id
 * Body: { content: string }
 */
const updateMessage = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const author = getAuthor(req);
  const { id } = req.params;
  const { content } = req.body;

  const message = await chatService.updateMessage(
    id,
    orgId,
    author.userId,
    content,
  );

  emitChatEvent(orgId, "chat:update", message);

  res.json(new ApiResponse(200, message, "Message updated"));
});

/**
 * DELETE /api/appointments/dashboard/chat/:id
 * Author can delete own message; admins can delete any.
 */
const deleteMessage = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const author = getAuthor(req);
  const { id } = req.params;
  const isAdmin = author.role === "admin";

  const message = await chatService.deleteMessage(
    id,
    orgId,
    author.userId,
    isAdmin,
  );

  emitChatEvent(orgId, "chat:delete", message);

  res.json(new ApiResponse(200, message, "Message deleted"));
});

export default {
  getMessages,
  createMessage,
  updateMessage,
  deleteMessage,
};