import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import chatService, { ChatAuthor } from "../services/chat.service";
import { emitChatEvent } from "../socket/chatSocket";
import logger from "../utils/logger";

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
  const model: "User" | "CrmUser" = crm ? "CrmUser" : "User";
  return { userId, model, name, role };
}

const getMessages = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { before, limit } = req.query;

  const result = await chatService.listMessages(orgId, {
    before: before as string | undefined,
    limit: limit ? parseInt(limit as string, 10) : undefined,
  });

  res.json(new ApiResponse(200, result, "Messages fetched successfully"));
});

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

  emitChatEvent(orgId, "chat:new", message);

  logger.info(
    { messageId: message._id, userId: author.userId, orgId },
    "Chat message created",
  );

  res.status(201).json(new ApiResponse(201, message, "Message sent"));
});

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