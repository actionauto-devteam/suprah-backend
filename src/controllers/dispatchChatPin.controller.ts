import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { IUser } from "../models/User.model";
import DispatchChannel from "../models/DispatchChannel.model";
import DispatchChatThread from "../models/DispatchChatThread.model";
import DispatchChatPin, { DISPATCH_CHAT_PIN_KINDS, DispatchChatPinKind } from "../models/DispatchChatPin.model";

// Driver Dispatch Chat pins: a driver keeps chosen conversations at the top of
// their Dispatch Chat page. A driver can pin only a private conversation that
// names them or a channel they belong to, and pins are private to them.

export const MAX_DISPATCH_CHAT_PINS = 20;

const getUser = (req: ExpressRequest) => req.user as IUser;

/** The person's pins that still point at something they can open; stale ones are removed. */
async function currentPins(user: IUser) {
  const pins = await DispatchChatPin.find({ userId: user._id }).sort({ pinnedAt: 1 }).lean();
  const threadIds = pins.filter((pin) => pin.kind === "thread").map((pin) => pin.targetId);
  const channelIds = pins.filter((pin) => pin.kind === "channel").map((pin) => pin.targetId);
  const [threads, channels] = await Promise.all([
    threadIds.length
      ? DispatchChatThread.find({ _id: { $in: threadIds }, driverId: user._id }).select("_id").lean()
      : [],
    channelIds.length
      ? DispatchChannel.find({ _id: { $in: channelIds }, "members.userId": user._id }).select("_id").lean()
      : [],
  ]);
  const reachable = new Set([
    ...threads.map((thread: any) => `thread:${thread._id}`),
    ...channels.map((channel: any) => `channel:${channel._id}`),
  ]);
  const stale = pins.filter((pin) => !reachable.has(`${pin.kind}:${pin.targetId}`));
  if (stale.length) {
    await DispatchChatPin.deleteMany({ userId: user._id, _id: { $in: stale.map((pin) => pin._id) } });
  }
  return pins
    .filter((pin) => reachable.has(`${pin.kind}:${pin.targetId}`))
    .map((pin) => ({ kind: pin.kind, id: String(pin.targetId), pinnedAt: pin.pinnedAt }));
}

// GET /api/driver-tracking/dispatch-chat/pins
const listPins = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const pins = await currentPins(getUser(req));
  return res.status(200).json(new ApiResponse(200, { pins }, "Pinned conversations fetched"));
});

// PUT /api/driver-tracking/dispatch-chat/pins  { kind: "thread" | "channel", id, pinned }
const setPin = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const kind = String(req.body?.kind ?? "") as DispatchChatPinKind;
  const id = String(req.body?.id ?? "").trim();
  const pinned = req.body?.pinned;

  if (!DISPATCH_CHAT_PIN_KINDS.includes(kind) || !mongoose.Types.ObjectId.isValid(id) || typeof pinned !== "boolean") {
    throw new ApiError(400, "Choose a conversation or channel to pin or unpin.");
  }

  if (!pinned) {
    await DispatchChatPin.deleteOne({ userId: user._id, kind, targetId: id });
    return res.status(200).json(new ApiResponse(200, { pins: await currentPins(user) }, "Conversation unpinned"));
  }

  const reachable =
    kind === "thread"
      ? await DispatchChatThread.exists({ _id: id, driverId: user._id })
      : await DispatchChannel.exists({ _id: id, "members.userId": user._id });
  if (!reachable) {
    throw new ApiError(404, kind === "thread" ? "This conversation isn't available to you." : "You're not in this channel anymore.");
  }

  // Count only pins that still work, so a left channel doesn't use up a slot.
  const pins = await currentPins(user);
  const already = pins.some((pin) => pin.kind === kind && pin.id === id);
  if (!already && pins.length >= MAX_DISPATCH_CHAT_PINS) {
    throw new ApiError(400, `You can pin up to ${MAX_DISPATCH_CHAT_PINS} conversations. Unpin one first.`);
  }

  await DispatchChatPin.updateOne(
    { userId: user._id, kind, targetId: id },
    { $setOnInsert: { userId: user._id, kind, targetId: id, pinnedAt: new Date() } },
    { upsert: true },
  ).catch((error: any) => {
    // Two quick taps can race the unique index; the pin exists either way.
    if (error?.code !== 11000) throw error;
  });

  return res.status(200).json(new ApiResponse(200, { pins: await currentPins(user) }, "Conversation pinned"));
});

export default { listPins, setPin };
