import mongoose from "mongoose";
import DispatchChatThread from "../models/DispatchChatThread.model";
import { emitToUser } from "../utils/socketEmitter";

export type DispatchChatThreadLike = {
  _id: mongoose.Types.ObjectId | string;
  organizationId: string;
  dispatcherId: mongoose.Types.ObjectId | string;
  driverId: mongoose.Types.ObjectId | string;
};

export async function ensureDispatchChatThread(params: {
  organizationId: string;
  dispatcherId: string | mongoose.Types.ObjectId;
  driverId: string | mongoose.Types.ObjectId;
}) {
  const { organizationId, dispatcherId, driverId } = params;

  try {
    return await DispatchChatThread.findOneAndUpdate(
      { organizationId, dispatcherId, driverId },
      {
        $setOnInsert: {
          organizationId,
          dispatcherId,
          driverId,
          lastMessageAt: null,
          lastMessagePreview: "",
          lastMessageSenderId: null,
          lastMessageType: null,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error: any) {
    // A simultaneous first message from two tabs can race the unique compound
    // index. Resolve that harmless race by returning the thread that won.
    if (error?.code === 11000) {
      const existing = await DispatchChatThread.findOne({
        organizationId,
        dispatcherId,
        driverId,
      });
      if (existing) return existing;
    }
    throw error;
  }
}

export async function touchDispatchChatThread(params: {
  threadId: string | mongoose.Types.ObjectId;
  senderId: string | mongoose.Types.ObjectId;
  messageType: "message" | "system";
  content?: string | null;
  fallbackPreview?: string;
  at?: Date;
}) {
  const previewSource =
    String(params.content ?? "").trim() || params.fallbackPreview || "Message";
  const lastMessagePreview = previewSource.replace(/\s+/g, " ").slice(0, 280);

  await DispatchChatThread.updateOne(
    { _id: params.threadId },
    {
      $set: {
        lastMessageAt: params.at ?? new Date(),
        lastMessagePreview,
        lastMessageSenderId: params.senderId,
        lastMessageType: params.messageType,
      },
    },
  );
}

export function emitToDispatchChatThreadParticipants(
  thread: DispatchChatThreadLike,
  event: string,
  payload: unknown,
) {
  const driverId = String(thread.driverId);
  const dispatcherId = String(thread.dispatcherId);

  emitToUser(driverId, event, payload);
  if (dispatcherId !== driverId) {
    emitToUser(dispatcherId, event, payload);
  }
}