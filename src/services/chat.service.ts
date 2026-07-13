import mongoose from "mongoose";
import ChatMessage, { IChatMessage } from "../models/ChatMessage.model";

export interface ChatAuthor {
  userId: string;
  model: "User" | "CrmUser";
  name: string;
  role: string;
}

interface ListOptions {
  limit?: number;
  before?: string;
}

const REPLY_PREVIEW_LEN = 140;

function toReplyPreview(msg: any) {
  if (!msg) return null;
  return {
    _id: msg._id?.toString(),
    authorName: msg.isDeleted ? null : msg.authorName,
    content: msg.isDeleted
      ? "This message was deleted"
      : (msg.content || "").slice(0, REPLY_PREVIEW_LEN),
    isDeleted: !!msg.isDeleted,
  };
}

function serialize(msg: any) {
  return {
    _id: msg._id?.toString(),
    organizationId: msg.organizationId,
    content: msg.isDeleted ? "" : msg.content,
    createdBy: msg.createdBy?.toString(),
    authorName: msg.authorName,
    authorRole: msg.authorRole,
    replyTo: toReplyPreview(msg.replyTo),
    isEdited: !!msg.isEdited,
    editedAt: msg.editedAt,
    isDeleted: !!msg.isDeleted,
    createdAt: msg.createdAt,
    updatedAt: msg.updatedAt,
  };
}

class ChatService {
  async listMessages(organizationId: string, options: ListOptions = {}) {
    const limit = Math.min(options.limit ?? 50, 100);

    const query: Record<string, any> = { organizationId };
    if (options.before && mongoose.isValidObjectId(options.before)) {
      query._id = { $lt: new mongoose.Types.ObjectId(options.before) };
    }

    const messages = await ChatMessage.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate({
        path: "replyTo",
        select: "content authorName isDeleted",
      })
      .lean();

    const hasMore = messages.length === limit;
    const oldestId = messages.length
      ? messages[messages.length - 1]._id?.toString()
      : null;

    return {
      messages: messages.map(serialize),
      hasMore,
      nextCursor: hasMore ? oldestId : null,
    };
  }

  async createMessage(
    organizationId: string,
    author: ChatAuthor,
    content: string,
    replyTo?: string,
  ) {
    const trimmed = (content || "").trim();
    if (!trimmed) {
      throw Object.assign(new Error("Message content is required"), {
        statusCode: 400,
      });
    }

    let replyToId: mongoose.Types.ObjectId | undefined;
    if (replyTo && mongoose.isValidObjectId(replyTo)) {
      const parent = await ChatMessage.findOne({
        _id: replyTo,
        organizationId,
      }).select("_id");
      if (parent) replyToId = parent._id as mongoose.Types.ObjectId;
    }

    const created = await ChatMessage.create({
      organizationId,
      content: trimmed,
      createdBy: new mongoose.Types.ObjectId(author.userId),
      createdByModel: author.model,
      authorName: author.name,
      authorRole: author.role,
      replyTo: replyToId ?? null,
    });

    const populated = await ChatMessage.findById(created._id)
      .populate({ path: "replyTo", select: "content authorName isDeleted" })
      .lean();

    return serialize(populated);
  }

  async updateMessage(
    messageId: string,
    organizationId: string,
    userId: string,
    content: string,
  ) {
    const trimmed = (content || "").trim();
    if (!trimmed) {
      throw Object.assign(new Error("Message content is required"), {
        statusCode: 400,
      });
    }

    const message = await ChatMessage.findOne({
      _id: messageId,
      organizationId,
    });
    if (!message) {
      throw Object.assign(new Error("Message not found"), { statusCode: 404 });
    }
    if (message.isDeleted) {
      throw Object.assign(new Error("Cannot edit a deleted message"), {
        statusCode: 400,
      });
    }
    if (message.createdBy.toString() !== userId) {
      throw Object.assign(new Error("You can only edit your own messages"), {
        statusCode: 403,
      });
    }

    message.content = trimmed;
    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();

    const populated = await ChatMessage.findById(message._id)
      .populate({ path: "replyTo", select: "content authorName isDeleted" })
      .lean();

    return serialize(populated);
  }

  async deleteMessage(
    messageId: string,
    organizationId: string,
    userId: string,
    isAdmin: boolean,
  ) {
    const message = await ChatMessage.findOne({
      _id: messageId,
      organizationId,
    });
    if (!message) {
      throw Object.assign(new Error("Message not found"), { statusCode: 404 });
    }

    const isOwner = message.createdBy.toString() === userId;
    if (!isOwner && !isAdmin) {
      throw Object.assign(
        new Error("You can only delete your own messages"),
        { statusCode: 403 },
      );
    }

    if (!message.isDeleted) {
      message.isDeleted = true;
      message.deletedAt = new Date();
      await message.save();
    }

    const populated = await ChatMessage.findById(message._id)
      .populate({ path: "replyTo", select: "content authorName isDeleted" })
      .lean();

    return serialize(populated);
  }
}

export default new ChatService();