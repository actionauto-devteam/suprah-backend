import { createHash } from "node:crypto";
import mongoose from "mongoose";
import DispatchChatMessage from "../models/DispatchChatMessage.model";

/** Called only after the controller authorizes this posted load and its creator. */
export async function recordAvailableLoadInquiry(params: {
  organizationId: string;
  thread: { _id: unknown; dispatcherId: unknown; driverId: unknown };
  driver: { _id: unknown; name?: string };
  load: { _id: unknown; loadNumber?: string };
  now?: Date;
}) {
  const { organizationId, thread, driver, load } = params;
  const now = params.now ?? new Date();
  // The built-in _id index makes simultaneous/retried opens idempotent within
  // a five-minute window. No new database index or load-request row is needed.
  const key = JSON.stringify(["available-load-inquiry-v1", organizationId,
    String(thread._id), String(driver._id), String(load._id), Math.floor(now.getTime() / 300000)]);
  const _id = new mongoose.Types.ObjectId(createHash("sha256").update(key).digest("hex").slice(0, 24));
  const loadNumber = String(load.loadNumber || load._id);
  const name = String(driver.name || "A driver").trim();
  const content = `${name} contacted you about available load ${loadNumber}.`;
  try {
    return await DispatchChatMessage.create({
      _id, organizationId, threadId: thread._id, dispatcherId: thread.dispatcherId,
      driverId: thread.driverId, senderId: driver._id, senderRole: "driver",
      messageType: "system", content, attachments: [], readBy: [driver._id],
      createdAt: now, updatedAt: now,
      systemEvent: { type: "driver_load_inquiry", title: "Available Load Inquiry", message: content,
        metadata: { loadId: String(load._id), loadNumber, driverId: String(driver._id),
          dispatcherId: String(thread.dispatcherId), threadId: String(thread._id),
          source: "available_load", inquiryOnly: true,
          audienceMessages: { driver: `You contacted dispatch about available load ${loadNumber}.`, dispatcher: content } } },
    });
  } catch (error: any) {
    if (error?.code === 11000) return null;
    throw error;
  }
}