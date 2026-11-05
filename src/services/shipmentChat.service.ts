import mongoose from "mongoose";
import Quote from "../models/Quote.model";
import Load from "../models/Load.model";
import User from "../models/User.model";
import Organization from "../models/Organization.model";
import ShipmentChatThread, { type IShipmentChatThread } from "../models/ShipmentChatThread.model";
import ShipmentChatMessage, { type IShipmentChatPhoto } from "../models/ShipmentChatMessage.model";
import { findQuoteFollower, type ShipmentFollower } from "./shipmentFollower";
import { loadContactIds, pickLoadContact } from "./dispatchChatContact";
import { storageService, BucketType } from "./storage.service";
import { SHIPMENT_NOT_FOUND } from "./customerShipmentTracking";
import {
  dispatcherChatState,
  driverChatState,
  isShipmentChatKind,
  shipmentChatClosedNote,
  type ShipmentChatAudience,
  type ShipmentChatKind,
  type ShipmentChatState,
} from "./shipmentChatAccess";
import { emitToUser } from "../utils/socketEmitter";
import { safeCreateNotification } from "../utils/safeNotification";
import { ApiError } from "../utils/ApiError";
import { SUPPORT_EMAIL } from "../utils/userMessages";
import logger from "../utils/logger";

/*
 * The customer chats on a shipment (rules in shipmentChatAccess.ts): the
 * customer who follows it on My Shipments talks privately with the load's
 * current driver, and with its current dispatcher. Text and photos.
 *
 * Every request works out who is in the chat from the load as it is now, so
 * a driver or dispatcher who handed the load on can't read or send anything,
 * even with an old link or an open page.
 */

const STAFF_ROLES = ["employee", "admin", "super_admin"];
export const MAX_CHAT_MESSAGE_LENGTH = 4000;
const PAGE_SIZE = 50;
const PHOTO_FOLDER = "shipment-chat-photos";
const PHOTO_LINK_SECONDS = 60 * 60;

export const LOAD_CHAT_NOT_FOUND = "We couldn't find this load. Refresh the page and try again.";
export const LOAD_NOT_YOURS = "This load isn't assigned to you anymore, so its customer chat is closed.";
export const CHAT_KIND_INVALID = "Choose the chat with your driver or with the dispatcher.";

const CHAT_LOAD_FIELDS = "_id organizationId quoteId loadNumber status assignedDriverId deliveredAt dispatchOwnerId createdBy";
const CHAT_QUOTE_FIELDS = "_id organizationId source requestedBy email portalShareOff vehicleName";

export interface ChatLoad {
  _id: mongoose.Types.ObjectId;
  organizationId: string;
  quoteId?: mongoose.Types.ObjectId | null;
  loadNumber?: string;
  status?: string;
  assignedDriverId?: mongoose.Types.ObjectId | null;
  deliveredAt?: Date | null;
  dispatchOwnerId?: mongoose.Types.ObjectId | null;
  createdBy?: mongoose.Types.ObjectId | null;
}

interface ChatQuote {
  _id: mongoose.Types.ObjectId;
  organizationId?: string;
  source?: string;
  requestedBy?: unknown;
  email?: string;
  portalShareOff?: boolean;
  vehicleName?: string;
}

interface StaffContact {
  _id: mongoose.Types.ObjectId;
  name?: string;
  role?: string;
  organizationId?: unknown;
}

export interface ChatPerson {
  id: string;
  name: string;
}

/** Everything one request needs about one chat, worked out from the load as it is now. */
export interface ShipmentChatContext {
  viewer: { id: string; role: ShipmentChatAudience };
  kind: ShipmentChatKind;
  /** False when no customer follows this load in the portal (no chat at all). */
  available: boolean;
  load: ChatLoad | null;
  quote: ChatQuote | null;
  customer: ShipmentFollower | null;
  dealerName: string;
  state: ShipmentChatState;
  /** The driver or dispatcher in the chat right now. */
  participant: ChatPerson | null;
  /** The viewer is one of the two people in the chat. */
  isParticipant: boolean;
  thread: IShipmentChatThread | null;
}

const toId = (value: unknown) => String(value ?? "").trim();
const isObjectId = (value: unknown) => mongoose.Types.ObjectId.isValid(toId(value));

const canTakeChat = (user: StaffContact, organizationId: string) =>
  STAFF_ROLES.includes(String(user.role ?? "")) &&
  (String(user.role) === "super_admin" || toId(user.organizationId) === organizationId);

/**
 * Each load's dispatcher for customer chats: whoever it was handed to,
 * otherwise whoever created it, otherwise the dealership's longest-serving
 * admin (the same rule as Dispatch Chat). Two queries however many loads.
 */
export async function loadDispatchers(loads: ChatLoad[]): Promise<Map<string, ChatPerson | null>> {
  const ids = [...new Set(loads.flatMap((load) => loadContactIds(load)))];
  const staff = ids.length
    ? await User.find({ _id: { $in: ids }, role: { $in: STAFF_ROLES }, isActive: true })
        .select("_id name role organizationId")
        .lean<StaffContact[]>()
    : [];
  const staffById = new Map(staff.map((user) => [String(user._id), user]));

  const pick = (load: ChatLoad, admin: StaffContact | null) =>
    pickLoadContact(load, staffById, admin, (user) => canTakeChat(user, String(load.organizationId)));

  const orgsNeedingAdmin = [...new Set(loads.filter((load) => !pick(load, null)).map((load) => String(load.organizationId)))];
  const admins = orgsNeedingAdmin.length
    ? await User.find({ organizationId: { $in: orgsNeedingAdmin }, role: "admin", isActive: true })
        .sort({ createdAt: 1, _id: 1 })
        .select("_id name role organizationId")
        .lean<StaffContact[]>()
    : [];
  const adminByOrg = new Map<string, StaffContact>();
  for (const admin of admins) {
    const key = toId(admin.organizationId);
    if (!adminByOrg.has(key)) adminByOrg.set(key, admin);
  }

  return new Map(
    loads.map((load) => {
      const contact = pick(load, adminByOrg.get(String(load.organizationId)) ?? null);
      return [String(load._id), contact ? { id: String(contact._id), name: String(contact.name ?? "").trim() || "Dispatcher" } : null];
    }),
  );
}

async function personName(id: string | null): Promise<ChatPerson | null> {
  if (!id || !isObjectId(id)) return null;
  const user = await User.findById(id).select("name").lean<{ name?: string }>();
  return { id, name: String(user?.name ?? "").trim() || "Driver" };
}

async function dealerNameOf(organizationId: unknown): Promise<string> {
  const id = toId(organizationId);
  if (!isObjectId(id)) return "";
  const org = await Organization.findById(id).select("name").lean<{ name?: string }>();
  return String(org?.name ?? "").trim();
}

/**
 * The live thread between this customer and this driver or dispatcher.
 * Retires any thread with someone who's no longer on the load, so the new
 * person starts fresh. Creates the thread only when asked (first message).
 */
async function currentThread(
  load: ChatLoad,
  quote: ChatQuote,
  kind: ShipmentChatKind,
  customerId: string,
  staffId: string,
  create: boolean,
): Promise<IShipmentChatThread | null> {
  await ShipmentChatThread.updateMany(
    { loadId: load._id, kind, active: true, $or: [{ staffId: { $ne: staffId } }, { customerId: { $ne: customerId } }] },
    { $set: { active: false, retiredAt: new Date() } },
  );
  const filter = { loadId: load._id, kind, active: true, staffId, customerId };
  if (!create) return ShipmentChatThread.findOne(filter);
  try {
    return await ShipmentChatThread.findOneAndUpdate(
      filter,
      { $setOnInsert: { organizationId: String(load.organizationId), quoteId: quote._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
  } catch (error: unknown) {
    // Two first messages at once: use the thread that won.
    if ((error as { code?: number })?.code === 11000) {
      const winner = await ShipmentChatThread.findOne(filter);
      if (winner) return winner;
      throw new ApiError(409, "This chat just changed hands. Refresh the page and try again.");
    }
    throw error;
  }
}

async function finishContext(
  base: Omit<ShipmentChatContext, "state" | "participant" | "isParticipant" | "thread">,
): Promise<ShipmentChatContext> {
  const { load, quote, customer, kind, viewer } = base;
  if (!base.available || !load || !quote || !customer) {
    const reason = base.available ? "not_booked" : null;
    return {
      ...base,
      state: { open: false, participantId: null, reason, closesAt: null },
      participant: null,
      isParticipant: false,
      thread: null,
    };
  }

  let participant: ChatPerson | null;
  if (kind === "driver") {
    participant = await personName(driverChatState(load).participantId);
  } else {
    participant = (await loadDispatchers([load])).get(String(load._id)) ?? null;
  }

  const thread = participant ? await currentThread(load, quote, kind, customer.id, participant.id, false) : null;
  const state = kind === "driver" ? driverChatState(load) : dispatcherChatState(participant?.id, Boolean(thread?.closedAt));
  const isParticipant = viewer.role === "customer" ? viewer.id === customer.id : Boolean(participant && participant.id === viewer.id);
  return { ...base, state, participant, isParticipant, thread };
}

/** A chat on one of the customer's own shipments (My Shipments). */
export async function resolveCustomerChat(customerId: string, quoteId: unknown, kind: unknown): Promise<ShipmentChatContext> {
  if (!isShipmentChatKind(kind)) throw new ApiError(400, CHAT_KIND_INVALID);
  const id = toId(quoteId);
  if (!isObjectId(id) || !isObjectId(customerId)) throw new ApiError(404, SHIPMENT_NOT_FOUND);

  const quote = await Quote.findById(id).select(CHAT_QUOTE_FIELDS).lean<ChatQuote>();
  const customer = await findQuoteFollower(quote);
  if (!quote || !customer || customer.id !== customerId) throw new ApiError(404, SHIPMENT_NOT_FOUND);

  const load = await Load.findOne({ quoteId: id, organizationId: quote.organizationId })
    .sort({ createdAt: -1 })
    .select(CHAT_LOAD_FIELDS)
    .lean<ChatLoad>();
  return finishContext({
    viewer: { id: customerId, role: "customer" },
    kind,
    available: true,
    load,
    quote,
    customer,
    dealerName: await dealerNameOf(quote.organizationId),
  });
}

/**
 * The customer chat on a load, for its driver (the driver chat) or for staff
 * of the load's dealership (the dispatcher chat).
 */
export async function resolveLoadChat(
  actor: { _id: unknown; role?: string },
  organizationId: unknown,
  loadId: unknown,
): Promise<ShipmentChatContext> {
  const actorId = toId(actor._id);
  const role = String(actor.role ?? "");
  const isDriver = role === "driver";
  if (!isDriver && !STAFF_ROLES.includes(role)) {
    throw new ApiError(403, "Customer chats are for the load's driver and dispatcher.");
  }
  const id = toId(loadId);
  if (!isObjectId(id)) throw new ApiError(404, LOAD_CHAT_NOT_FOUND);
  const load = await Load.findById(id).select(CHAT_LOAD_FIELDS).lean<ChatLoad>();
  if (!load) throw new ApiError(404, LOAD_CHAT_NOT_FOUND);
  if (isDriver) {
    if (toId(load.assignedDriverId) !== actorId) throw new ApiError(403, LOAD_NOT_YOURS);
  } else if (!toId(organizationId) || String(load.organizationId) !== toId(organizationId)) {
    throw new ApiError(404, LOAD_CHAT_NOT_FOUND);
  }

  const quote = load.quoteId
    ? await Quote.findOne({ _id: load.quoteId, organizationId: load.organizationId }).select(CHAT_QUOTE_FIELDS).lean<ChatQuote>()
    : null;
  const customer = await findQuoteFollower(quote);
  return finishContext({
    viewer: { id: actorId, role: isDriver ? "driver" : "dispatcher" },
    kind: isDriver ? "driver" : "dispatcher",
    available: Boolean(quote && customer),
    load,
    quote,
    customer,
    dealerName: await dealerNameOf(load.organizationId),
  });
}

export interface ShipmentChatView {
  kind: ShipmentChatKind;
  /** False when no customer follows this load in the portal: no chat. */
  available: boolean;
  threadId: string | null;
  /** Messages can be sent. */
  open: boolean;
  /** Why it's closed, and what to do instead, in plain English. */
  note: string | null;
  /** Driver chat after delivery: when it closes. */
  closesAt: string | null;
  /** The viewer is in this chat (staff who aren't the dispatcher only see who is). */
  isParticipant: boolean;
  /** The other person in the chat, as the viewer sees them. */
  withName: string | null;
  /** Staff who aren't the dispatcher: who handles this customer's chat. */
  handledBy: string | null;
  vehicleName: string;
  loadNumber: string;
  dealerName: string;
  unread: number;
  /** The dispatcher can close the chat when the customer has what they need. */
  canClose: boolean;
  canReopen: boolean;
}

async function unreadFor(threadId: unknown, viewerId: string): Promise<number> {
  if (!threadId) return 0;
  return ShipmentChatMessage.countDocuments({ threadId, readBy: { $ne: new mongoose.Types.ObjectId(viewerId) } });
}

/** What the viewer sees about the chat (no messages). */
export async function shipmentChatView(ctx: ShipmentChatContext): Promise<ShipmentChatView> {
  const { viewer, kind, state, participant, customer, isParticipant } = ctx;
  const audience = viewer.role;
  const isDispatcherViewer = audience === "dispatcher" && isParticipant;
  let note = shipmentChatClosedNote(kind, state.reason, audience, ctx.dealerName);
  if (!ctx.available) note = "No customer follows this load in the customer portal, so there's no customer chat.";
  else if (!isParticipant && audience === "dispatcher" && participant) {
    note = `Only ${participant.name}, this load's dispatcher, can message this customer.`;
  }
  const readable = isParticipant && Boolean(ctx.thread);
  return {
    kind,
    available: ctx.available,
    threadId: readable ? String(ctx.thread!._id) : null,
    open: isParticipant && state.open,
    note,
    closesAt: state.closesAt,
    isParticipant,
    withName: audience === "customer" ? participant?.name ?? null : customer?.name || (customer ? "Customer" : null),
    handledBy: !isParticipant && audience === "dispatcher" ? participant?.name ?? null : null,
    vehicleName: String(ctx.quote?.vehicleName ?? "").trim(),
    loadNumber: String(ctx.load?.loadNumber ?? ""),
    dealerName: ctx.dealerName,
    unread: readable ? await unreadFor(ctx.thread!._id, viewer.id) : 0,
    canClose: isDispatcherViewer && kind === "dispatcher" && state.open,
    canReopen: isDispatcherViewer && kind === "dispatcher" && state.reason === "closed_by_dispatcher",
  };
}

export interface ShipmentChatPhotoView {
  url: string;
  name: string;
  /** False when the photo can't be shown right now (storage unavailable). */
  available: boolean;
}

export interface ShipmentChatMessageView {
  id: string;
  /** The viewer sent it. */
  mine: boolean;
  senderRole: "customer" | "driver" | "dispatcher";
  senderName: string;
  content: string;
  photos: ShipmentChatPhotoView[];
  createdAt: string;
  /** The other person has read it (for the viewer's own messages). */
  seen: boolean;
}

interface MessageRecord {
  _id: unknown;
  senderId: unknown;
  senderRole: "customer" | "driver" | "dispatcher";
  content?: string;
  photos?: IShipmentChatPhoto[];
  readBy?: unknown[];
  createdAt: Date | string;
}

async function photoView(photo: IShipmentChatPhoto): Promise<ShipmentChatPhotoView> {
  let url = "";
  try {
    const signed = await storageService.getSignedUrl(photo.fileKey, PHOTO_LINK_SECONDS);
    // Never hand out an unsigned private key.
    if (signed && (/^https:\/\//i.test(signed) || signed.startsWith("/uploads/"))) url = signed;
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : "unknown" }, "[ShipmentChat] Photo link unavailable");
  }
  return { url, name: photo.originalName || "Photo", available: Boolean(url) };
}

function senderNameFor(ctx: ShipmentChatContext, record: MessageRecord): string {
  if (record.senderRole === "customer") return ctx.customer?.name || "Customer";
  if (ctx.participant && toId(record.senderId) === ctx.participant.id) return ctx.participant.name;
  return record.senderRole === "driver" ? "Driver" : "Dispatcher";
}

export async function serializeChatMessage(ctx: ShipmentChatContext, record: MessageRecord, viewerId: string): Promise<ShipmentChatMessageView> {
  const senderId = toId(record.senderId);
  return {
    id: toId(record._id),
    mine: senderId === viewerId,
    senderRole: record.senderRole,
    senderName: senderNameFor(ctx, record),
    content: String(record.content ?? ""),
    photos: await Promise.all((record.photos ?? []).map(photoView)),
    createdAt: new Date(record.createdAt).toISOString(),
    seen: (record.readBy ?? []).some((id) => toId(id) !== senderId),
  };
}

/** The chat's messages, oldest first, 50 at a time going back from `before`. */
export async function listChatMessages(ctx: ShipmentChatContext, before?: unknown) {
  if (!ctx.isParticipant || !ctx.thread) return { messages: [] as ShipmentChatMessageView[], hasMore: false };
  const beforeDate = typeof before === "string" && before ? new Date(before) : null;
  const rows = await ShipmentChatMessage.find({
    threadId: ctx.thread._id,
    ...(beforeDate && Number.isFinite(beforeDate.getTime()) ? { createdAt: { $lt: beforeDate } } : {}),
  })
    .sort({ createdAt: -1, _id: -1 })
    .limit(PAGE_SIZE + 1)
    .lean<MessageRecord[]>();
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE).reverse();
  return { messages: await Promise.all(page.map((row) => serializeChatMessage(ctx, row, ctx.viewer.id))), hasMore };
}

function requireOpenChat(ctx: ShipmentChatContext) {
  if (!ctx.available) throw new ApiError(404, "No customer follows this load in the customer portal, so there's no customer chat.");
  if (!ctx.isParticipant) {
    const why = ctx.participant
      ? `Only ${ctx.participant.name}, this load's dispatcher, can message this customer.`
      : shipmentChatClosedNote(ctx.kind, ctx.state.reason, ctx.viewer.role, ctx.dealerName) ?? "You're not in this chat.";
    throw new ApiError(403, why);
  }
  if (!ctx.state.open || !ctx.load || !ctx.quote || !ctx.customer || !ctx.participant) {
    throw new ApiError(409, shipmentChatClosedNote(ctx.kind, ctx.state.reason, ctx.viewer.role, ctx.dealerName) ?? "This chat is closed.");
  }
  return { load: ctx.load, quote: ctx.quote, customer: ctx.customer, participant: ctx.participant };
}

/** The two people in the chat: who receives what the viewer sends. */
function recipientsOf(ctx: ShipmentChatContext) {
  return [ctx.customer?.id, ctx.participant?.id].filter((id): id is string => Boolean(id));
}

/** Sends live updates to both people, each with their own view of the message. */
async function emitMessage(ctx: ShipmentChatContext, thread: IShipmentChatThread, record: MessageRecord) {
  for (const userId of recipientsOf(ctx)) {
    emitToUser(userId, "shipment-chat:message", {
      threadId: String(thread._id),
      loadId: String(thread.loadId),
      quoteId: String(thread.quoteId),
      kind: ctx.kind,
      message: await serializeChatMessage(ctx, record, userId),
    });
  }
}

function emitChanged(ctx: ShipmentChatContext, thread: IShipmentChatThread) {
  for (const userId of recipientsOf(ctx)) {
    emitToUser(userId, "shipment-chat:changed", {
      threadId: String(thread._id),
      loadId: String(thread.loadId),
      quoteId: String(thread.quoteId),
      kind: ctx.kind,
    });
  }
}

const previewOf = (content: string, photoCount: number) => {
  const text = content.replace(/\s+/g, " ").trim();
  if (text) return text.length > 280 ? `${text.slice(0, 277)}…` : text;
  return photoCount === 1 ? "Sent a photo" : `Sent ${photoCount} photos`;
};

/** Tells the other person about a new message. Never throws. */
async function notifyRecipient(ctx: ShipmentChatContext, thread: IShipmentChatThread, messageId: string, preview: string) {
  const { load, quote, customer, participant, kind, viewer } = ctx;
  if (!load || !quote || !customer || !participant) return;
  const loadId = String(load._id);
  const fromCustomer = viewer.role === "customer";
  const recipientId = fromCustomer ? participant.id : customer.id;
  const vehicle = String(quote.vehicleName ?? "").trim();

  let title: string;
  let route: string;
  if (fromCustomer) {
    title = `${customer.name || "Customer"} (customer)`;
    route = kind === "driver" ? `/driver/loads/${loadId}?chat=customer` : `/transportation/load/${loadId}?chat=customer`;
  } else {
    title = kind === "driver" ? `${participant.name} (your driver)` : `${participant.name} (${ctx.dealerName || "dispatcher"})`;
    route = `/customer/shipments?shipment=${String(quote._id)}&chat=${kind}`;
  }
  const about = vehicle ? `About the ${vehicle}: ` : "";

  await safeCreateNotification({
    userId: recipientId,
    organizationId: String(load.organizationId),
    type: "message_received",
    title: title.slice(0, 200),
    message: `${about}${preview}`.slice(0, 500),
    metadata: {
      route,
      loadId,
      quoteId: String(quote._id),
      threadId: String(thread._id),
      messageId,
      shipmentChatKind: kind,
      pushSource: "Shipment chat",
      pushPresentation: "direct_message",
      pushTag: `shipment-chat:${String(thread._id)}`,
      pushTopic: `shipment-chat:${String(thread._id)}`,
      soundProfile: "message",
    },
  });
}

export interface SendChatMessageInput {
  content?: unknown;
  clientMessageId?: string | null;
  photos?: Express.Multer.File[];
}

/** Sends a message (text, photos or both) from the viewer to the other person. */
export async function sendChatMessage(ctx: ShipmentChatContext, input: SendChatMessageInput): Promise<{ message: ShipmentChatMessageView; repeated: boolean }> {
  const { load, quote, customer, participant } = requireOpenChat(ctx);
  const content = typeof input.content === "string" ? input.content.trim() : "";
  const files = input.photos ?? [];
  if (!content && files.length === 0) throw new ApiError(400, "Type a message or add a photo before sending.");
  if (content.length > MAX_CHAT_MESSAGE_LENGTH) {
    throw new ApiError(400, `Messages can be up to ${MAX_CHAT_MESSAGE_LENGTH} characters. Shorten your message and try again.`);
  }

  const senderId = new mongoose.Types.ObjectId(ctx.viewer.id);
  const clientMessageId = input.clientMessageId ?? null;
  if (clientMessageId) {
    const existing = await ShipmentChatMessage.findOne({ senderId, clientMessageId }).lean<MessageRecord>();
    if (existing) return { message: await serializeChatMessage(ctx, existing, ctx.viewer.id), repeated: true };
  }

  const thread = await currentThread(load, quote, ctx.kind, customer.id, participant.id, true);
  if (!thread) throw new ApiError(409, "This chat just changed hands. Refresh the page and try again.");
  ctx.thread = thread;

  const photos: IShipmentChatPhoto[] = [];
  const removeUploaded = () =>
    Promise.allSettled(photos.map((photo) => storageService.delete(photo.fileKey, BucketType.PRIVATE)));
  try {
    for (const file of files) {
      const url = await storageService.upload(file, PHOTO_FOLDER, BucketType.PRIVATE, { allowLocalFallback: false });
      photos.push({
        fileKey: storageService.getKeyFromUrl(url) || url,
        originalName: file.originalname || "Photo",
        mimeType: file.mimetype,
        size: file.size,
      });
    }
  } catch (error) {
    await removeUploaded();
    logger.error({ error, threadId: String(thread._id) }, "[ShipmentChat] Photo upload failed");
    throw new ApiError(503, `We couldn't send your photos right now. Try again in a few minutes. If it keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`);
  }

  let created;
  try {
    created = await ShipmentChatMessage.create({
      organizationId: String(load.organizationId),
      threadId: thread._id,
      loadId: load._id,
      senderId,
      senderRole: ctx.viewer.role,
      content,
      photos,
      readBy: [senderId],
      ...(clientMessageId ? { clientMessageId } : {}),
    });
  } catch (error: unknown) {
    await removeUploaded();
    // Two copies of the same send arrived at once: return the one that won.
    if (clientMessageId && (error as { code?: number })?.code === 11000) {
      const winner = await ShipmentChatMessage.findOne({ senderId, clientMessageId }).lean<MessageRecord>();
      if (winner) return { message: await serializeChatMessage(ctx, winner, ctx.viewer.id), repeated: true };
    }
    throw error;
  }

  const record = created.toObject() as unknown as MessageRecord;
  const preview = previewOf(content, photos.length);
  await ShipmentChatThread.updateOne(
    { _id: thread._id, $or: [{ lastMessageAt: null }, { lastMessageAt: { $lte: created.createdAt } }] },
    { $set: { lastMessageAt: created.createdAt, lastMessagePreview: preview, lastMessageSenderId: senderId } },
  );

  await emitMessage(ctx, thread, record);
  void notifyRecipient(ctx, thread, String(created._id), preview).catch((error) => {
    logger.error({ error, threadId: String(thread._id) }, "[ShipmentChat] Non-fatal: failed to notify the other person");
  });

  return { message: await serializeChatMessage(ctx, record, ctx.viewer.id), repeated: false };
}

/** Marks the messages the viewer has on screen (up to `readUpTo`) as read. */
export async function markChatRead(ctx: ShipmentChatContext, readUpTo?: unknown) {
  if (!ctx.isParticipant || !ctx.thread) return { updated: 0 };
  const upTo = typeof readUpTo === "string" ? new Date(readUpTo) : null;
  const viewerId = new mongoose.Types.ObjectId(ctx.viewer.id);
  const result = await ShipmentChatMessage.updateMany(
    {
      threadId: ctx.thread._id,
      readBy: { $ne: viewerId },
      ...(upTo && Number.isFinite(upTo.getTime()) ? { createdAt: { $lte: upTo } } : {}),
    },
    { $addToSet: { readBy: viewerId } },
  );
  if (result.modifiedCount > 0) {
    for (const userId of recipientsOf(ctx)) {
      emitToUser(userId, "shipment-chat:read", {
        threadId: String(ctx.thread._id),
        loadId: String(ctx.thread.loadId),
        quoteId: String(ctx.thread.quoteId),
        kind: ctx.kind,
        readerId: ctx.viewer.id,
      });
    }
  }
  return { updated: result.modifiedCount };
}

/**
 * The dispatcher closes their chat with the customer (the customer can still
 * read it), or reopens it.
 */
export async function setDispatcherChatClosed(ctx: ShipmentChatContext, close: boolean) {
  if (ctx.kind !== "dispatcher" || ctx.viewer.role !== "dispatcher" || !ctx.isParticipant) {
    throw new ApiError(403, "Only this load's dispatcher can close or reopen the customer chat.");
  }
  if (!ctx.load || !ctx.quote || !ctx.customer || !ctx.participant) throw new ApiError(404, LOAD_CHAT_NOT_FOUND);
  const thread = await currentThread(ctx.load, ctx.quote, "dispatcher", ctx.customer.id, ctx.participant.id, true);
  if (!thread) throw new ApiError(409, "This chat just changed hands. Refresh the page and try again.");
  await ShipmentChatThread.updateOne(
    { _id: thread._id },
    close
      ? { $set: { closedAt: new Date(), closedBy: new mongoose.Types.ObjectId(ctx.viewer.id) } }
      : { $set: { closedAt: null, closedBy: null } },
  );
  emitChanged(ctx, thread);
}

export interface CustomerChatSummary {
  /** Messages can be sent. */
  open: boolean;
  /** There's someone in the chat, so it can be opened (read-only when closed). */
  readable: boolean;
  unread: number;
  /** Why it's closed, and what to do instead. */
  note: string | null;
  /** Dispatcher chat: the dispatcher's name. */
  name: string | null;
}

/**
 * For My Shipments: each load's two chats as the customer sees them, with
 * unread counts. Four queries however many shipments.
 */
export async function customerChatSummaries(
  customerId: string,
  loads: Array<ChatLoad & { dealerName?: string }>,
): Promise<Map<string, { driver: CustomerChatSummary; dispatcher: CustomerChatSummary }>> {
  const result = new Map<string, { driver: CustomerChatSummary; dispatcher: CustomerChatSummary }>();
  if (!isObjectId(customerId) || loads.length === 0) return result;

  const dispatchers = await loadDispatchers(loads);
  const threads = await ShipmentChatThread.find({ customerId, loadId: { $in: loads.map((load) => load._id) }, active: true })
    .select("_id loadId kind staffId closedAt")
    .lean<Array<{ _id: mongoose.Types.ObjectId; loadId: unknown; kind: ShipmentChatKind; staffId: unknown; closedAt?: Date | null }>>();
  const counts = threads.length
    ? await ShipmentChatMessage.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
        { $match: { threadId: { $in: threads.map((thread) => thread._id) }, readBy: { $ne: new mongoose.Types.ObjectId(customerId) } } },
        { $group: { _id: "$threadId", n: { $sum: 1 } } },
      ])
    : [];
  const unreadByThread = new Map(counts.map((row) => [String(row._id), row.n]));
  const threadFor = (loadId: string, kind: ShipmentChatKind, staffId: string | null) =>
    staffId ? threads.find((thread) => toId(thread.loadId) === loadId && thread.kind === kind && toId(thread.staffId) === staffId) : undefined;

  for (const load of loads) {
    const loadId = String(load._id);
    const driverState = driverChatState(load);
    const driverThread = threadFor(loadId, "driver", driverState.participantId);
    const dispatcher = dispatchers.get(loadId) ?? null;
    const dispatcherThread = threadFor(loadId, "dispatcher", dispatcher?.id ?? null);
    const dispatcherState = dispatcherChatState(dispatcher?.id, Boolean(dispatcherThread?.closedAt));
    result.set(loadId, {
      driver: {
        open: driverState.open,
        readable: Boolean(driverState.participantId),
        unread: driverThread ? unreadByThread.get(String(driverThread._id)) ?? 0 : 0,
        note: shipmentChatClosedNote("driver", driverState.reason, "customer", load.dealerName),
        name: null,
      },
      dispatcher: {
        open: dispatcherState.open,
        readable: Boolean(dispatcher),
        unread: dispatcherThread ? unreadByThread.get(String(dispatcherThread._id)) ?? 0 : 0,
        note: shipmentChatClosedNote("dispatcher", dispatcherState.reason, "customer", load.dealerName),
        name: dispatcher?.name ?? null,
      },
    });
  }
  return result;
}
