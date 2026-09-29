import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { SELECT_ORGANIZATION } from "../utils/userMessages";
import { parseClientRequestId } from "../utils/clientRequestId";
import { emitToUser } from "../utils/socketEmitter";
import { safeCreateNotification } from "../utils/safeNotification";
import logger from "../utils/logger";
import User, { IUser } from "../models/User.model";
import Organization from "../models/Organization.model";
import DispatchChannel, { IDispatchChannel } from "../models/DispatchChannel.model";
import DispatchChannelMessage from "../models/DispatchChannelMessage.model";
import { storageService, BucketType } from "../services/storage.service";

// Business rules live in models/DispatchChannel.model.ts.

const STAFF_ROLES = ["employee", "admin", "super_admin"];
const CHANNEL_USER_ROLES = [...STAFF_ROLES, "driver"];
const MAX_MEMBERS = 200;
const MAX_PENDING_SUGGESTIONS = 50;
const MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const PEOPLE_SEARCH_LIMIT = 20;
// Photo and file links work for this long; a fresh load gets new ones.
const ATTACHMENT_LINK_SECONDS = 60 * 60;

const CHANNEL_NOT_AVAILABLE =
  "This channel isn't available. It may have been removed, or you're no longer a member.";
const CHANNEL_CLOSED =
  "This channel is closed, so nothing new can be added. Its history stays readable to its members.";
const ADMINS_ONLY = "Only channel administrators can do that.";
const MESSAGE_NOT_AVAILABLE = "That message isn't available anymore. Refresh the channel.";

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function getUser(req: ExpressRequest): IUser {
  const user = req.user as IUser | undefined;
  if (!user) throw new ApiError(401, "Please sign in again.");
  if (!CHANNEL_USER_ROLES.includes(String(user.role))) {
    throw new ApiError(403, "Channels are only available to drivers and dispatch staff.");
  }
  return user;
}

const kindOf = (user: { role?: string }) => (user.role === "driver" ? "driver" : "staff") as "driver" | "staff";
const idOf = (value: unknown) => String((value as any)?._id ?? value ?? "");

function validObjectId(value: unknown, message = CHANNEL_NOT_AVAILABLE) {
  const id = String(value ?? "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) throw new ApiError(404, message);
  return id;
}

async function loadChannelForMember(channelId: unknown, userId: string) {
  const id = validObjectId(channelId);
  const channel = await DispatchChannel.findOne({ _id: id, "members.userId": userId });
  if (!channel) throw new ApiError(404, CHANNEL_NOT_AVAILABLE);
  return channel;
}

const memberOf = (channel: IDispatchChannel, userId: string) =>
  channel.members.find((member) => idOf(member.userId) === userId) ?? null;
const isCreator = (channel: IDispatchChannel, userId: string) => idOf(channel.createdBy) === userId;
const isAdmin = (channel: IDispatchChannel, userId: string) => memberOf(channel, userId)?.role === "admin";

function assertAdmin(channel: IDispatchChannel, userId: string) {
  if (!isAdmin(channel, userId)) throw new ApiError(403, ADMINS_ONLY);
}

function assertOpen(channel: IDispatchChannel) {
  if (channel.status !== "open") throw new ApiError(409, CHANNEL_CLOSED);
}

// Filter that re-checks, in the write itself, that the actor is still an
// administrator of an open channel.
const openChannelAdministeredBy = (channelId: unknown, actorId: string) => ({
  _id: channelId,
  status: "open",
  members: { $elemMatch: { userId: new mongoose.Types.ObjectId(actorId), role: "admin" } },
});

async function resolveAvatar(raw: unknown): Promise<string | null> {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return value;
  try {
    return (await storageService.getSignedUrl(value, 7 * 24 * 60 * 60)) || null;
  } catch {
    return null;
  }
}

type PersonView = {
  id: string;
  name: string;
  avatar: string | null;
  kind: "driver" | "staff";
  organizationName: string | null;
};

/** Name, driver/staff and (for staff) organization. Never email or phone. */
async function peopleViews(userIds: string[]): Promise<Map<string, PersonView>> {
  const ids = [...new Set(userIds.filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  if (!ids.length) return new Map();
  const users: any[] = await User.find({ _id: { $in: ids } }).select("_id name avatar role organizationId").lean();
  const orgIds = [
    ...new Set(
      users
        .filter((user) => kindOf(user) === "staff" && user.organizationId)
        .map((user) => String(user.organizationId)),
    ),
  ];
  const orgs: any[] = orgIds.length ? await Organization.find({ _id: { $in: orgIds } }).select("_id name").lean() : [];
  const orgName = new Map(orgs.map((org) => [String(org._id), String(org.name ?? "")]));
  const views = await Promise.all(
    users.map(async (user): Promise<PersonView> => ({
      id: String(user._id),
      name: user.name || (kindOf(user) === "driver" ? "Driver" : "Dispatcher"),
      avatar: await resolveAvatar(user.avatar),
      kind: kindOf(user),
      organizationName:
        kindOf(user) === "staff" && user.organizationId ? orgName.get(String(user.organizationId)) ?? null : null,
    })),
  );
  return new Map(views.map((view) => [view.id, view]));
}

/** Active drivers and staff who can be put in a channel. */
async function findEligibleUsers(ids: string[]) {
  const valid = [...new Set(ids.map((id) => String(id ?? "").trim()).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  if (!valid.length) return [];
  return User.find({ _id: { $in: valid }, isActive: true, role: { $in: CHANNEL_USER_ROLES } })
    .select("_id name role organizationId")
    .lean();
}

function channelRoute(user: { role?: string }, channelId?: string) {
  if (kindOf(user) === "driver") {
    return channelId ? `/driver/channels?channelId=${encodeURIComponent(channelId)}` : "/driver/channels";
  }
  return channelId ? `/crm/suprah-mail?dispatchChannelId=${encodeURIComponent(channelId)}` : "/crm/suprah-mail";
}

/** Bell notification for being added, removed, a role change or a suggestion. */
async function notifyPerson(
  person: { _id: unknown; role?: string; organizationId?: unknown },
  channel: IDispatchChannel,
  title: string,
  message: string,
  options: { linkToChannel?: boolean } = {},
) {
  const channelId = String(channel._id);
  await safeCreateNotification({
    userId: String(person._id),
    organizationId: String(person.organizationId ?? channel.organizationId),
    type: "dispatch_channel",
    title,
    message,
    metadata: {
      channelId,
      channelName: channel.name,
      route: channelRoute(person, options.linkToChannel === false ? undefined : channelId),
    },
  } as any);
}

function emitToMembers(channel: IDispatchChannel, event: string, payload: Record<string, unknown>) {
  for (const member of channel.members) emitToUser(idOf(member.userId), event, payload);
}

function preview(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Channel list preview: the text, or what kind of files were sent. */
function messagePreview(content: string, attachments: Array<{ mimeType?: string }> = []) {
  if (content.trim()) return preview(content);
  if (attachments.length === 1) {
    const type = String(attachments[0]?.mimeType ?? "");
    if (type.startsWith("image/")) return "Sent a photo";
    if (type.startsWith("video/")) return "Sent a video";
    return "Sent a file";
  }
  return attachments.length ? `Sent ${attachments.length} files` : "";
}

/** Short-lived private links. The stored file key never leaves the server. */
async function attachmentViews(attachments: unknown) {
  const list: any[] = Array.isArray(attachments) ? attachments : [];
  return Promise.all(
    list.map(async (attachment) => {
      const key = String(attachment?.fileKey ?? "").trim();
      let url = "";
      if (key) {
        try {
          const signed = await storageService.getSignedUrl(key, ATTACHMENT_LINK_SECONDS);
          if (signed && (/^https?:\/\//i.test(signed) || signed.startsWith("/uploads/"))) url = signed;
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : "unknown signing error" },
            "Channel attachment link could not be created",
          );
        }
      }
      return {
        url,
        available: Boolean(url),
        originalName: String(attachment?.originalName || "Attachment"),
        mimeType: String(attachment?.mimeType || "application/octet-stream"),
        size: Number(attachment?.size) || 0,
      };
    }),
  );
}

async function removeStoredFiles(attachments: Array<{ fileKey?: string }>) {
  const results = await Promise.allSettled(
    attachments
      .map((attachment) => String(attachment?.fileKey ?? "").trim())
      .filter(Boolean)
      .map((key) => storageService.delete(key, BucketType.PRIVATE)),
  );
  const failed = results.filter((result) => result.status === "rejected").length;
  if (failed) logger.warn({ failed }, "Some channel files could not be removed from storage");
}

async function serializeMessages(messages: any[]) {
  const people = await peopleViews(messages.map((message) => idOf(message.senderId)));
  return Promise.all(
    messages.map(async (message) => {
      const senderId = idOf(message.senderId);
      const deleted = Boolean(message.deletedAt);
      return {
        id: String(message._id),
        channelId: String(message.channelId),
        messageType: message.messageType,
        content: deleted ? "" : message.content ?? "",
        attachments: deleted ? [] : await attachmentViews(message.attachments),
        systemEvent: message.systemEvent ?? null,
        clientMessageId: message.clientMessageId ?? null,
        createdAt: message.createdAt,
        editedAt: deleted ? null : message.editedAt ?? null,
        deletedAt: message.deletedAt ?? null,
        // Removed by an administrator rather than by the person who sent it.
        deletedByAdmin: deleted && Boolean(message.deletedBy) && idOf(message.deletedBy) !== senderId,
        sender: people.get(senderId) ?? { id: senderId, name: "Former member", avatar: null, kind: message.senderKind, organizationName: null },
      };
    }),
  );
}

/** Keeps the channel list preview right when the newest message changes. */
async function refreshPreviewIfLatest(channelId: unknown, message: any) {
  const text = message.deletedAt ? "Message deleted" : messagePreview(message.content ?? "", message.attachments ?? []);
  await DispatchChannel.updateOne({ _id: channelId, lastMessageAt: message.createdAt }, { $set: { lastMessagePreview: text } });
}

/** A channel event line ("Ana added Ben") stored with the messages. */
async function postSystemMessage(
  channel: IDispatchChannel,
  actor: IUser,
  content: string,
  type: string,
  metadata: Record<string, unknown> = {},
) {
  try {
    const message = await DispatchChannelMessage.create({
      channelId: channel._id,
      senderId: actor._id,
      senderKind: kindOf(actor),
      messageType: "system",
      content,
      systemEvent: { type, metadata },
    });
    await DispatchChannel.updateOne(
      { _id: channel._id, $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: message.createdAt } }] },
      { $set: { lastMessageAt: message.createdAt, lastMessagePreview: preview(content) } },
    );
    const [serialized] = await serializeMessages([message.toObject()]);
    emitToMembers(channel, "dispatch-channel:message", { channelId: String(channel._id), message: serialized });
  } catch (error) {
    logger.error({ error, channelId: String(channel._id), type }, "Non-fatal: channel event line could not be saved");
  }
}

async function unreadCounts(channels: IDispatchChannel[], userId: string) {
  const ranges = channels.map((channel) => {
    const member = memberOf(channel, userId);
    return {
      channelId: channel._id,
      createdAt: { $gt: member?.lastReadAt ?? member?.joinedAt ?? new Date(0) },
    };
  });
  if (!ranges.length) return new Map<string, number>();
  const rows = await DispatchChannelMessage.aggregate([
    { $match: { $or: ranges, senderId: { $ne: new mongoose.Types.ObjectId(userId) }, deletedAt: null } },
    { $group: { _id: "$channelId", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row: any) => [String(row._id), Number(row.count) || 0]));
}

function channelSummary(channel: IDispatchChannel, userId: string, unread: number) {
  const admin = isAdmin(channel, userId);
  return {
    id: String(channel._id),
    name: channel.name,
    description: channel.description ?? "",
    status: channel.status,
    closedAt: channel.closedAt ?? null,
    myRole: memberOf(channel, userId)?.role ?? "member",
    isCreator: isCreator(channel, userId),
    memberCount: channel.members.length,
    lastMessageAt: channel.lastMessageAt ?? null,
    lastMessagePreview: channel.lastMessagePreview ?? "",
    unreadCount: unread,
    pendingSuggestionCount: admin ? channel.suggestions.filter((item) => item.status === "pending").length : 0,
  };
}

async function channelDetail(channel: IDispatchChannel, userId: string) {
  const admin = isAdmin(channel, userId);
  const pending = channel.suggestions.filter(
    (item) => item.status === "pending" && (admin || idOf(item.suggestedBy) === userId),
  );
  const people = await peopleViews([
    ...channel.members.map((member) => idOf(member.userId)),
    ...pending.flatMap((item) => [idOf(item.userId), idOf(item.suggestedBy)]),
  ]);
  const unread = (await unreadCounts([channel], userId)).get(String(channel._id)) ?? 0;
  const person = (id: string): PersonView =>
    people.get(id) ?? { id, name: "Former member", avatar: null, kind: "staff", organizationName: null };
  return {
    ...channelSummary(channel, userId, unread),
    createdBy: idOf(channel.createdBy),
    members: channel.members
      .map((member) => ({
        ...person(idOf(member.userId)),
        role: member.role,
        isCreator: idOf(member.userId) === idOf(channel.createdBy),
        joinedAt: member.joinedAt,
      }))
      .sort((a, b) => Number(b.isCreator) - Number(a.isCreator) || (a.role === b.role ? a.name.localeCompare(b.name) : a.role === "admin" ? -1 : 1)),
    suggestions: pending.map((item) => ({
      id: String(item._id),
      person: person(idOf(item.userId)),
      suggestedBy: person(idOf(item.suggestedBy)),
      createdAt: item.createdAt,
    })),
  };
}

async function respondWithChannel(res: ExpressResponse, channelId: unknown, userId: string, message: string, status = 200) {
  const fresh = await DispatchChannel.findById(channelId);
  if (!fresh || !memberOf(fresh, userId)) {
    return res.status(status).json(new ApiResponse(status, null, message));
  }
  return res.status(status).json(new ApiResponse(status, await channelDetail(fresh, userId), message));
}

// ─── Channels ────────────────────────────────────────────────────────────────

// GET /api/dispatch-channels
const listChannels = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channels = await DispatchChannel.find({ "members.userId": user._id }).sort({ lastMessageAt: -1, updatedAt: -1 }).limit(200);
  const unread = await unreadCounts(channels, userId);
  const data = channels.map((channel) => channelSummary(channel, userId, unread.get(String(channel._id)) ?? 0));
  return res.status(200).json(
    new ApiResponse(200, { channels: data, unreadTotal: data.reduce((sum, item) => sum + item.unreadCount, 0) }, "Channels fetched"),
  );
});

// POST /api/dispatch-channels  { name, description?, memberIds? }
const createChannel = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  if (!STAFF_ROLES.includes(String(user.role))) {
    throw new ApiError(403, "Only dispatchers and admins can create channels. Ask one to add you.");
  }
  const organizationId = String(req.orgId ?? "").trim();
  if (!organizationId || organizationId === "global") throw new ApiError(403, SELECT_ORGANIZATION);

  const name = String(req.body?.name ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  if (name.length < 2 || name.length > 80) throw new ApiError(400, "Give the channel a name of 2 to 80 characters.");
  if (description.length > 500) throw new ApiError(400, "The channel description can be up to 500 characters.");

  const requested = Array.isArray(req.body?.memberIds) ? req.body.memberIds : [];
  const people = (await findEligibleUsers(requested)).filter((person: any) => String(person._id) !== String(user._id));
  if (people.length + 1 > MAX_MEMBERS) throw new ApiError(400, `A channel can have up to ${MAX_MEMBERS} people.`);

  const now = new Date();
  const channel = await DispatchChannel.create({
    name,
    description,
    organizationId,
    createdBy: user._id,
    members: [
      { userId: user._id, role: "admin", addedBy: user._id, joinedAt: now, lastReadAt: now },
      ...people.map((person: any) => ({ userId: person._id, role: "member", addedBy: user._id, joinedAt: now })),
    ],
  });

  await postSystemMessage(channel, user, `${user.name || "A dispatcher"} created the channel.`, "channel_created");
  for (const person of people) {
    await notifyPerson(person, channel, "Added to a Channel", `${user.name || "A dispatcher"} added you to the channel "${channel.name}".`);
  }
  emitToMembers(channel, "dispatch-channel:updated", { channelId: String(channel._id) });

  return res.status(201).json(new ApiResponse(201, await channelDetail(channel, String(user._id)), "Channel created"));
});

// GET /api/dispatch-channels/:id
const getChannel = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const channel = await loadChannelForMember(req.params.id, String(user._id));
  return res.status(200).json(new ApiResponse(200, await channelDetail(channel, String(user._id)), "Channel fetched"));
});

// PATCH /api/dispatch-channels/:id  { name?, description? }
const updateChannel = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  assertOpen(channel);
  assertAdmin(channel, userId);

  const set: Record<string, string> = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name ?? "").trim();
    if (name.length < 2 || name.length > 80) throw new ApiError(400, "Give the channel a name of 2 to 80 characters.");
    set.name = name;
  }
  if (req.body?.description !== undefined) {
    const description = String(req.body.description ?? "").trim();
    if (description.length > 500) throw new ApiError(400, "The channel description can be up to 500 characters.");
    set.description = description;
  }
  if (!Object.keys(set).length) return respondWithChannel(res, channel._id, userId, "Nothing to change");

  const updated = await DispatchChannel.findOneAndUpdate(openChannelAdministeredBy(channel._id, userId), { $set: set }, { new: true });
  if (!updated) throw new ApiError(409, "This channel changed while you were editing it. Refresh and try again.");
  if (set.name && set.name !== channel.name) {
    await postSystemMessage(updated, user, `${user.name || "An administrator"} renamed the channel to "${set.name}".`, "channel_renamed");
  }
  emitToMembers(updated, "dispatch-channel:updated", { channelId: String(updated._id) });
  return respondWithChannel(res, updated._id, userId, "Channel updated");
});

// POST /api/dispatch-channels/:id/close  (creator only)
const closeChannel = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  if (!isCreator(channel, userId)) throw new ApiError(403, "Only the person who created this channel can close it.");
  if (channel.status === "closed") return respondWithChannel(res, channel._id, userId, "Channel already closed");

  const updated = await DispatchChannel.findOneAndUpdate(
    { _id: channel._id, status: "open", createdBy: user._id },
    { $set: { status: "closed", closedAt: new Date(), closedBy: user._id } },
    { new: true },
  );
  if (!updated) return respondWithChannel(res, channel._id, userId, "Channel already closed");
  await postSystemMessage(updated, user, `${user.name || "The creator"} closed the channel. Its history stays readable.`, "channel_closed");
  emitToMembers(updated, "dispatch-channel:updated", { channelId: String(updated._id) });
  return respondWithChannel(res, updated._id, userId, "Channel closed");
});

// ─── Members ─────────────────────────────────────────────────────────────────

// POST /api/dispatch-channels/:id/members  { userIds }  (administrators)
const addMembers = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  assertOpen(channel);
  assertAdmin(channel, userId);

  const requested = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
  const people = (await findEligibleUsers(requested)).filter((person: any) => !memberOf(channel, String(person._id)));
  if (!people.length) {
    throw new ApiError(400, "Choose at least one person who isn't in the channel yet. Only active drivers and staff can be added.");
  }
  if (channel.members.length + people.length > MAX_MEMBERS) {
    throw new ApiError(400, `A channel can have up to ${MAX_MEMBERS} people.`);
  }

  const added: any[] = [];
  for (const person of people) {
    const result = await DispatchChannel.updateOne(
      { ...openChannelAdministeredBy(channel._id, userId), "members.userId": { $ne: person._id } },
      {
        $push: { members: { userId: person._id, role: "member", addedBy: user._id, joinedAt: new Date() } },
        // An approved-by-adding person no longer needs a pending suggestion.
        $set: { "suggestions.$[pending].status": "approved", "suggestions.$[pending].decidedBy": user._id, "suggestions.$[pending].decidedAt": new Date() },
      },
      { arrayFilters: [{ "pending.userId": person._id, "pending.status": "pending" }] },
    );
    if (result.modifiedCount > 0) added.push(person);
  }

  const updated = await DispatchChannel.findById(channel._id);
  if (updated && added.length) {
    const names = added.map((person) => person.name || "someone").join(", ");
    await postSystemMessage(updated, user, `${user.name || "An administrator"} added ${names}.`, "members_added", {
      userIds: added.map((person) => String(person._id)),
    });
    for (const person of added) {
      await notifyPerson(person, updated, "Added to a Channel", `${user.name || "An administrator"} added you to the channel "${updated.name}".`);
    }
    emitToMembers(updated, "dispatch-channel:updated", { channelId: String(updated._id) });
  }
  return respondWithChannel(res, channel._id, userId, added.length ? "People added" : "Nobody new was added");
});

async function removeMember(channel: IDispatchChannel, actor: IUser, target: any, reason: "removed" | "left") {
  const targetId = String(target._id);
  const filter: Record<string, unknown> = { _id: channel._id, "members.userId": target._id, createdBy: { $ne: target._id } };
  if (reason === "removed") Object.assign(filter, openChannelAdministeredBy(channel._id, String(actor._id)));
  const updated = await DispatchChannel.findOneAndUpdate(filter, { $pull: { members: { userId: target._id } } }, { new: true });
  if (!updated) return null;

  emitToUser(targetId, "dispatch-channel:removed", { channelId: String(updated._id) });
  if (reason === "left") {
    await postSystemMessage(updated, actor, `${actor.name || "Someone"} left the channel.`, "member_left", { userId: targetId });
  } else {
    await postSystemMessage(updated, actor, `${actor.name || "An administrator"} removed ${target.name || "someone"}.`, "member_removed", {
      userId: targetId,
    });
    await notifyPerson(target, updated, "Removed from a Channel", `${actor.name || "An administrator"} removed you from the channel "${updated.name}".`, {
      linkToChannel: false,
    });
  }
  emitToMembers(updated, "dispatch-channel:updated", { channelId: String(updated._id) });
  return updated;
}

// DELETE /api/dispatch-channels/:id/members/:userId  (administrators; never the creator)
const removeMemberRoute = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  const targetId = validObjectId(req.params.userId, "That person isn't in this channel.");

  if (targetId === userId) {
    if (isCreator(channel, userId)) throw new ApiError(400, "You created this channel, so you can't leave it. You can close it instead.");
    await removeMember(channel, user, user, "left");
    return res.status(200).json(new ApiResponse(200, null, "You left the channel"));
  }

  assertOpen(channel);
  assertAdmin(channel, userId);
  if (idOf(channel.createdBy) === targetId) throw new ApiError(403, "Nobody can remove the person who created the channel.");
  if (!memberOf(channel, targetId)) throw new ApiError(404, "That person isn't in this channel anymore.");

  const target: any = (await User.findById(targetId).select("_id name role organizationId").lean()) ?? { _id: targetId, name: "someone" };
  const updated = await removeMember(channel, user, target, "removed");
  if (!updated) throw new ApiError(409, "This channel changed while you were editing it. Refresh and try again.");
  return respondWithChannel(res, channel._id, userId, "Person removed");
});

// POST /api/dispatch-channels/:id/leave  (anyone but the creator)
const leaveChannel = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  if (isCreator(channel, userId)) throw new ApiError(400, "You created this channel, so you can't leave it. You can close it instead.");
  await removeMember(channel, user, user, "left");
  return res.status(200).json(new ApiResponse(200, null, "You left the channel"));
});

// PATCH /api/dispatch-channels/:id/members/:userId/role  { role }  (creator and administrators)
const changeMemberRole = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  assertOpen(channel);
  assertAdmin(channel, userId);

  const targetId = validObjectId(req.params.userId, "That person isn't in this channel.");
  const role = String(req.body?.role ?? "");
  if (!["admin", "member"].includes(role)) throw new ApiError(400, "Choose Administrator or Member.");
  if (idOf(channel.createdBy) === targetId) throw new ApiError(403, "The person who created the channel is always an administrator.");
  const current = memberOf(channel, targetId);
  if (!current) throw new ApiError(404, "That person isn't in this channel anymore.");
  if (current.role === role) return respondWithChannel(res, channel._id, userId, "No change");

  const updated = await DispatchChannel.findOneAndUpdate(
    openChannelAdministeredBy(channel._id, userId),
    { $set: { "members.$[target].role": role } },
    { new: true, arrayFilters: [{ "target.userId": new mongoose.Types.ObjectId(targetId) }] },
  );
  if (!updated) throw new ApiError(409, "This channel changed while you were editing it. Refresh and try again.");

  const target: any = (await User.findById(targetId).select("_id name role organizationId").lean()) ?? { _id: targetId, name: "someone" };
  const label = role === "admin" ? "an administrator" : "a member";
  await postSystemMessage(updated, user, `${user.name || "An administrator"} made ${target.name || "someone"} ${label}.`, "role_changed", {
    userId: targetId,
    role,
  });
  await notifyPerson(target, updated, "Channel Role Changed", `${user.name || "An administrator"} made you ${label} of the channel "${updated.name}".`);
  emitToMembers(updated, "dispatch-channel:updated", { channelId: String(updated._id) });
  return respondWithChannel(res, updated._id, userId, "Role changed");
});

// ─── Suggestions ─────────────────────────────────────────────────────────────

// POST /api/dispatch-channels/:id/suggestions  { userId }  (members)
const suggestMember = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  assertOpen(channel);
  if (isAdmin(channel, userId)) throw new ApiError(400, "As an administrator you can add people directly.");

  const [person]: any[] = await findEligibleUsers([req.body?.userId]);
  if (!person) throw new ApiError(400, "Choose an active driver or staff member to suggest.");
  if (memberOf(channel, String(person._id))) throw new ApiError(409, `${person.name || "That person"} is already in this channel.`);
  if (channel.suggestions.some((item) => item.status === "pending" && idOf(item.userId) === String(person._id))) {
    return respondWithChannel(res, channel._id, userId, `${person.name || "That person"} has already been suggested. An administrator will decide.`);
  }
  if (channel.suggestions.filter((item) => item.status === "pending").length >= MAX_PENDING_SUGGESTIONS) {
    throw new ApiError(409, "This channel has a lot of suggestions waiting. Try again after an administrator reviews them.");
  }

  const updated = await DispatchChannel.findOneAndUpdate(
    {
      _id: channel._id,
      status: "open",
      "members.userId": user._id,
      suggestions: { $not: { $elemMatch: { userId: person._id, status: "pending" } } },
    },
    { $push: { suggestions: { userId: person._id, suggestedBy: user._id, status: "pending", createdAt: new Date() } } },
    { new: true },
  );
  if (!updated) return respondWithChannel(res, channel._id, userId, "Suggestion already sent");

  const admins: any[] = await User.find({
    _id: { $in: updated.members.filter((member) => member.role === "admin").map((member) => member.userId) },
  })
    .select("_id role organizationId")
    .lean();
  for (const admin of admins) {
    await notifyPerson(admin, updated, "Channel Suggestion", `${user.name || "A member"} suggested adding ${person.name || "someone"} to "${updated.name}". Approve or decline it in the channel.`);
  }
  emitToMembers(updated, "dispatch-channel:updated", { channelId: String(updated._id) });
  return respondWithChannel(res, updated._id, userId, "Suggestion sent to the administrators", 201);
});

async function decideSuggestion(req: ExpressRequest, res: ExpressResponse, approve: boolean) {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  assertOpen(channel);
  assertAdmin(channel, userId);

  const suggestionId = validObjectId(req.params.suggestionId, "That suggestion isn't available anymore.");
  const suggestion = channel.suggestions.find((item) => String(item._id) === suggestionId);
  if (!suggestion || suggestion.status !== "pending") {
    return respondWithChannel(res, channel._id, userId, "That suggestion was already decided.");
  }

  const [person]: any[] = approve ? await findEligibleUsers([idOf(suggestion.userId)]) : [null];
  if (approve && !person) throw new ApiError(409, "That person can't be added anymore (their account isn't active). Decline the suggestion instead.");
  if (approve && channel.members.length + 1 > MAX_MEMBERS) throw new ApiError(400, `A channel can have up to ${MAX_MEMBERS} people.`);

  const decided = { "suggestions.$[s].status": approve ? "approved" : "declined", "suggestions.$[s].decidedBy": user._id, "suggestions.$[s].decidedAt": new Date() };
  const update: Record<string, any> = { $set: decided };
  const filter: Record<string, any> = openChannelAdministeredBy(channel._id, userId);
  const addsMember = approve && !memberOf(channel, idOf(suggestion.userId));
  if (addsMember) {
    update.$push = { members: { userId: person._id, role: "member", addedBy: user._id, joinedAt: new Date() } };
    filter["members.userId"] = { $ne: person._id };
  }
  const updated = await DispatchChannel.findOneAndUpdate(filter, update, {
    new: true,
    arrayFilters: [{ "s._id": new mongoose.Types.ObjectId(suggestionId), "s.status": "pending" }],
  });
  if (!updated) throw new ApiError(409, "This channel changed while you were reviewing it. Refresh and try again.");

  const suggester: any = await User.findById(suggestion.suggestedBy).select("_id name role organizationId").lean();
  const personName = person?.name || (await User.findById(suggestion.userId).select("name").lean() as any)?.name || "someone";
  if (addsMember) {
    await postSystemMessage(updated, user, `${user.name || "An administrator"} added ${personName}, suggested by ${suggester?.name || "a member"}.`, "suggestion_approved", {
      userId: idOf(suggestion.userId),
      suggestedBy: idOf(suggestion.suggestedBy),
    });
    await notifyPerson(person, updated, "Added to a Channel", `${user.name || "An administrator"} added you to the channel "${updated.name}".`);
  }
  if (suggester && memberOf(updated, String(suggester._id))) {
    await notifyPerson(
      suggester,
      updated,
      approve ? "Suggestion Approved" : "Suggestion Declined",
      approve
        ? `${personName} was added to "${updated.name}" as you suggested.`
        : `${user.name || "An administrator"} declined adding ${personName} to "${updated.name}".`,
    );
  }
  emitToMembers(updated, "dispatch-channel:updated", { channelId: String(updated._id) });
  return respondWithChannel(res, updated._id, userId, approve ? "Suggestion approved" : "Suggestion declined");
}

// POST /api/dispatch-channels/:id/suggestions/:suggestionId/approve|decline  (administrators)
const approveSuggestion = asyncHandler((req: ExpressRequest, res: ExpressResponse) => decideSuggestion(req, res, true));
const declineSuggestion = asyncHandler((req: ExpressRequest, res: ExpressResponse) => decideSuggestion(req, res, false));

// ─── Messages ────────────────────────────────────────────────────────────────

// GET /api/dispatch-channels/:id/messages?before&beforeId&limit
const getMessages = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const channel = await loadChannelForMember(req.params.id, String(user._id));
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(String(req.query.limit ?? DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE));

  const filter: Record<string, any> = { channelId: channel._id };
  const before = req.query.before ? new Date(String(req.query.before)) : null;
  if (before && Number.isFinite(before.getTime())) {
    const beforeId = String(req.query.beforeId ?? "");
    // Same-instant messages page by id, so none are skipped.
    filter.$or = mongoose.Types.ObjectId.isValid(beforeId)
      ? [{ createdAt: { $lt: before } }, { createdAt: before, _id: { $lt: new mongoose.Types.ObjectId(beforeId) } }]
      : [{ createdAt: { $lt: before } }];
  }

  const rows = await DispatchChannelMessage.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  return res.status(200).json(new ApiResponse(200, { messages: await serializeMessages(page), hasMore }, "Messages fetched"));
});

function checkMessageLength(content: string) {
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new ApiError(400, `Messages can be up to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters. Shorten it and send again.`);
  }
}

/** The first copy of a retried send, if one was already stored. */
async function findSentCopy(senderId: unknown, clientMessageId: string | null) {
  if (!clientMessageId) return null;
  const existing = await DispatchChannelMessage.findOne({ senderId, clientMessageId }).lean();
  return existing ? (await serializeMessages([existing]))[0] : null;
}

/** Updates the channel list preview and the sender's read mark, then tells everyone. */
async function publishNewMessage(channel: IDispatchChannel, sender: IUser, message: any) {
  await DispatchChannel.updateOne(
    { _id: channel._id, $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: message.createdAt } }] },
    { $set: { lastMessageAt: message.createdAt, lastMessagePreview: messagePreview(message.content ?? "", message.attachments ?? []) } },
  );
  // The sender has read everything up to their own message.
  await DispatchChannel.updateOne(
    { _id: channel._id },
    { $set: { "members.$[me].lastReadAt": message.createdAt } },
    { arrayFilters: [{ "me.userId": sender._id }] },
  );

  const [serialized] = await serializeMessages([message.toObject()]);
  emitToMembers(channel, "dispatch-channel:message", { channelId: String(channel._id), message: serialized });
  return serialized;
}

// POST /api/dispatch-channels/:id/messages  { content, clientMessageId? }
const sendMessage = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  assertOpen(channel);

  const content = String(req.body?.content ?? "").trim();
  if (!content) throw new ApiError(400, "Write a message before sending.");
  checkMessageLength(content);
  const clientMessageId = parseClientRequestId(req.body?.clientMessageId);

  const alreadySent = await findSentCopy(user._id, clientMessageId);
  if (alreadySent) return res.status(200).json(new ApiResponse(200, alreadySent, "Message already sent"));

  let message: any;
  try {
    message = await DispatchChannelMessage.create({
      channelId: channel._id,
      senderId: user._id,
      senderKind: kindOf(user),
      messageType: "message",
      content,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  } catch (error: any) {
    const racedCopy = Number(error?.code) === 11000 ? await findSentCopy(user._id, clientMessageId) : null;
    if (racedCopy) return res.status(200).json(new ApiResponse(200, racedCopy, "Message already sent"));
    throw error;
  }

  const serialized = await publishNewMessage(channel, user, message);
  return res.status(201).json(new ApiResponse(201, serialized, "Message sent"));
});

// POST /api/dispatch-channels/:id/attachments  (form data: files, content?, clientMessageId?)
// File types, sizes and count are checked by uploadDispatchChatFiles, the same
// rules as private Dispatch Chat.
const uploadAttachments = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  assertOpen(channel);

  const files = (req.files || []) as Express.Multer.File[];
  if (!files.length) throw new ApiError(400, "Choose at least one photo or file to send.");
  const content = String(req.body?.content ?? "").trim();
  checkMessageLength(content);
  const clientMessageId = parseClientRequestId(req.body?.clientMessageId);

  const alreadySent = await findSentCopy(user._id, clientMessageId);
  if (alreadySent) return res.status(200).json(new ApiResponse(200, alreadySent, "Files already sent"));

  const attachments: Array<{ fileKey: string; originalName: string; mimeType: string; size: number }> = [];
  try {
    for (const file of files) {
      const stored = await storageService.upload(file, "dispatch-channel-attachments", BucketType.PRIVATE, {
        allowLocalFallback: false,
      });
      attachments.push({
        fileKey: storageService.getKeyFromUrl(stored) || stored,
        originalName: file.originalname || "Attachment",
        mimeType: file.mimetype || "application/octet-stream",
        size: file.size,
      });
    }
  } catch (error) {
    await removeStoredFiles(attachments);
    logger.error({ error, channelId: String(channel._id) }, "Channel file upload failed");
    throw new ApiError(503, "Sending files isn't available right now. Please try again in a moment.");
  }

  let message: any;
  try {
    message = await DispatchChannelMessage.create({
      channelId: channel._id,
      senderId: user._id,
      senderKind: kindOf(user),
      messageType: "message",
      content,
      attachments,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  } catch (error: any) {
    await removeStoredFiles(attachments);
    const racedCopy = Number(error?.code) === 11000 ? await findSentCopy(user._id, clientMessageId) : null;
    if (racedCopy) return res.status(200).json(new ApiResponse(200, racedCopy, "Files already sent"));
    throw error;
  }

  const serialized = await publishNewMessage(channel, user, message);
  return res.status(201).json(new ApiResponse(201, serialized, "Files sent"));
});

async function loadChannelMessage(channel: IDispatchChannel, messageId: unknown) {
  const id = validObjectId(messageId, MESSAGE_NOT_AVAILABLE);
  const message: any = await DispatchChannelMessage.findOne({ _id: id, channelId: channel._id }).lean();
  // Channel event lines ("Ana added Ben") can't be edited or deleted.
  if (!message || message.messageType !== "message") throw new ApiError(404, MESSAGE_NOT_AVAILABLE);
  return message;
}

async function publishChangedMessage(channel: IDispatchChannel, message: any) {
  await refreshPreviewIfLatest(channel._id, message);
  const [serialized] = await serializeMessages([message]);
  emitToMembers(channel, "dispatch-channel:message-updated", { channelId: String(channel._id), message: serialized });
  return serialized;
}

// PATCH /api/dispatch-channels/:id/messages/:messageId  { content }  (the sender only)
const editMessage = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  const message = await loadChannelMessage(channel, req.params.messageId);
  if (idOf(message.senderId) !== userId) throw new ApiError(403, "You can only edit your own messages.");
  if (message.deletedAt) throw new ApiError(409, "This message was deleted, so it can't be edited.");
  assertOpen(channel);

  const content = String(req.body?.content ?? "").trim();
  if (!content && !(message.attachments ?? []).length) {
    throw new ApiError(400, "A message can't be empty. Delete it instead.");
  }
  checkMessageLength(content);
  if (content === (message.content ?? "")) {
    const [unchanged] = await serializeMessages([message]);
    return res.status(200).json(new ApiResponse(200, unchanged, "No change"));
  }

  const updated = await DispatchChannelMessage.findOneAndUpdate(
    { _id: message._id, senderId: user._id, deletedAt: null },
    { $set: { content, editedAt: new Date() } },
    { new: true },
  ).lean();
  if (!updated) throw new ApiError(409, "This message was deleted, so it can't be edited.");

  const serialized = await publishChangedMessage(channel, updated);
  return res.status(200).json(new ApiResponse(200, serialized, "Message edited"));
});

// DELETE /api/dispatch-channels/:id/messages/:messageId  (the sender, or any channel administrator)
// Allowed in closed channels too, so people can still take back what they shared.
const deleteMessage = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const userId = String(user._id);
  const channel = await loadChannelForMember(req.params.id, userId);
  const message = await loadChannelMessage(channel, req.params.messageId);
  if (message.deletedAt) {
    const [current] = await serializeMessages([message]);
    return res.status(200).json(new ApiResponse(200, current, "Message already deleted"));
  }
  if (idOf(message.senderId) !== userId && !isAdmin(channel, userId)) {
    throw new ApiError(403, "You can delete your own messages. Only channel administrators can delete other people's messages.");
  }

  const updated = await DispatchChannelMessage.findOneAndUpdate(
    { _id: message._id, deletedAt: null },
    { $set: { deletedAt: new Date(), deletedBy: user._id, content: "", attachments: [], editedAt: null } },
    { new: true },
  ).lean();
  if (!updated) {
    const current: any = await DispatchChannelMessage.findById(message._id).lean();
    const [serialized] = await serializeMessages([current ?? message]);
    return res.status(200).json(new ApiResponse(200, serialized, "Message already deleted"));
  }

  await removeStoredFiles(message.attachments ?? []);
  const serialized = await publishChangedMessage(channel, updated);
  return res.status(200).json(new ApiResponse(200, serialized, "Message deleted"));
});

// POST /api/dispatch-channels/:id/read  { readUpTo? }
const markRead = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const channel = await loadChannelForMember(req.params.id, String(user._id));
  const now = new Date();
  const requested = req.body?.readUpTo ? new Date(String(req.body.readUpTo)) : now;
  // Only what was on screen, and never moves backwards.
  const readUpTo = Number.isFinite(requested.getTime()) && requested < now ? requested : now;
  await DispatchChannel.updateOne(
    { _id: channel._id },
    { $set: { "members.$[me].lastReadAt": readUpTo } },
    {
      // Not yet read this far (an empty value counts as not read).
      arrayFilters: [{ "me.userId": user._id, "me.lastReadAt": { $not: { $gte: readUpTo } } }],
    },
  );
  emitToUser(String(user._id), "dispatch-channel:read", { channelId: String(channel._id) });
  return res.status(200).json(new ApiResponse(200, { readUpTo }, "Marked as read"));
});

// ─── People search ───────────────────────────────────────────────────────────

// GET /api/dispatch-channels/people?search=  (drivers and staff anywhere on the platform)
const searchPeople = asyncHandler(async (req: ExpressRequest, res: ExpressResponse) => {
  const user = getUser(req);
  const search = String(req.query.search ?? "").trim().slice(0, 60);
  if (search.length < 2) {
    return res.status(200).json(new ApiResponse(200, { people: [] }, "Type at least 2 letters of a name"));
  }
  const users: any[] = await User.find({
    _id: { $ne: user._id },
    isActive: true,
    role: { $in: CHANNEL_USER_ROLES },
    name: new RegExp(escapeRegex(search), "i"),
  })
    .select("_id")
    .sort({ name: 1 })
    .limit(PEOPLE_SEARCH_LIMIT)
    .lean();
  const views = await peopleViews(users.map((row) => String(row._id)));
  const people = users.map((row) => views.get(String(row._id))).filter(Boolean);
  return res.status(200).json(new ApiResponse(200, { people }, "People found"));
});

export default {
  listChannels,
  createChannel,
  getChannel,
  updateChannel,
  closeChannel,
  addMembers,
  removeMember: removeMemberRoute,
  leaveChannel,
  changeMemberRole,
  suggestMember,
  approveSuggestion,
  declineSuggestion,
  getMessages,
  sendMessage,
  uploadAttachments,
  editMessage,
  deleteMessage,
  markRead,
  searchPeople,
};
