import mongoose from "mongoose";
import Load from "../models/Load.model";
import Quote from "../models/Quote.model";
import Organization from "../models/Organization.model";
import ShipmentChatThread from "../models/ShipmentChatThread.model";
import ShipmentChatMessage from "../models/ShipmentChatMessage.model";
import ShipmentReview from "../models/ShipmentReview.model";
import { findQuoteFollowers } from "./shipmentFollower";
import { CHAT_LOAD_FIELDS, loadDispatchers, type ChatLoad } from "./shipmentChat.service";
import { dispatcherChatState, driverChatState, type ShipmentChatKind, type ShipmentChatState } from "./shipmentChatAccess";
import { ApiError } from "../utils/ApiError";
import { SELECT_ORGANIZATION } from "../utils/userMessages";
import logger from "../utils/logger";

/*
 * The Customers section of Dispatch Chat: the customer chats a driver or
 * dispatcher is in right now, newest first, with unread counts. A driver sees
 * their chats with customers of the loads they carry, and a dispatcher their
 * chats on their dealership's loads.
 *
 * Only chats with at least one message are listed (a chat starts from the
 * load page or when the customer writes). Who is in a chat follows the same
 * rules as on the load (shipmentChat.service), so a chat whose load changed
 * hands, or whose customer was unlinked, never shows here.
 */

const STAFF_ROLES = ["employee", "admin", "super_admin"];
/** The newest chats listed at once. */
export const MAX_INBOX_CHATS = 100;
const QUOTE_FIELDS = "_id organizationId source requestedBy email portalShareOff vehicleName";

export interface CustomerChatInboxItem {
  /** The load the chat is about: the chat opens with the load's customer-chat routes. */
  loadId: string;
  threadId: string;
  /** "driver": the viewer is the load's driver. "dispatcher": its dispatcher. */
  kind: ShipmentChatKind;
  customerName: string;
  vehicleName: string;
  loadNumber: string;
  /** The load's dealership (drivers can carry loads for several). */
  dealerName: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  /** The viewer sent the last message. */
  lastMessageMine: boolean;
  unread: number;
  /** Messages can be sent (otherwise the chat can still be read). */
  open: boolean;
}

export interface CustomerChatInbox {
  chats: CustomerChatInboxItem[];
  unreadTotal: number;
}

interface InboxThread {
  _id: mongoose.Types.ObjectId;
  loadId: unknown;
  quoteId: unknown;
  customerId: unknown;
  closedAt?: Date | null;
  lastMessageAt?: Date | null;
  lastMessagePreview?: string;
  lastMessageSenderId?: unknown;
}

interface InboxQuote {
  _id: mongoose.Types.ObjectId;
  organizationId?: string;
  source?: string;
  requestedBy?: unknown;
  email?: string;
  portalShareOff?: boolean;
  vehicleName?: string;
}

const EMPTY: CustomerChatInbox = { chats: [], unreadTotal: 0 };
const toId = (value: unknown) => String(value ?? "").trim();
const isObjectId = (value: unknown) => mongoose.Types.ObjectId.isValid(toId(value));

/** The viewer's customer chats (drivers and dispatch staff only). */
export async function listCustomerChatInbox(
  actor: { _id: unknown; role?: string },
  organizationId: unknown,
  now = Date.now(),
): Promise<CustomerChatInbox> {
  const viewerId = toId(actor._id);
  const role = String(actor.role ?? "");
  const isDriver = role === "driver";
  if (!isDriver && !STAFF_ROLES.includes(role)) {
    throw new ApiError(403, "Customer chats are for drivers and dispatch staff.");
  }
  const orgId = toId(organizationId);
  if (!isDriver && !orgId) throw new ApiError(403, SELECT_ORGANIZATION);
  if (!isObjectId(viewerId)) return EMPTY;

  const kind: ShipmentChatKind = isDriver ? "driver" : "dispatcher";
  const threads = await ShipmentChatThread.find({
    staffId: viewerId,
    kind,
    active: true,
    lastMessageAt: { $ne: null },
    ...(isDriver ? {} : { organizationId: orgId }),
  })
    .sort({ lastMessageAt: -1 })
    .limit(MAX_INBOX_CHATS)
    .select("_id loadId quoteId customerId closedAt lastMessageAt lastMessagePreview lastMessageSenderId")
    .lean<InboxThread[]>();
  if (threads.length === 0) return EMPTY;

  const loadIds = [...new Set(threads.map((thread) => toId(thread.loadId)))];
  const quoteIds = [...new Set(threads.map((thread) => toId(thread.quoteId)))];
  const [loads, quotes, receipts] = await Promise.all([
    Load.find({ _id: { $in: loadIds } }).select(CHAT_LOAD_FIELDS).lean<ChatLoad[]>(),
    Quote.find({ _id: { $in: quoteIds } }).select(QUOTE_FIELDS).lean<InboxQuote[]>(),
    ShipmentReview.find({ loadId: { $in: loadIds } }).select("loadId").lean<Array<{ loadId: unknown }>>(),
  ]);
  const loadById = new Map(loads.map((load) => [String(load._id), load]));
  const quoteById = new Map(quotes.map((quote) => [String(quote._id), quote]));
  const received = new Set(receipts.map((receipt) => toId(receipt.loadId)));
  const orgIds = [...new Set(loads.map((load) => String(load.organizationId)).filter(isObjectId))];

  const [followers, dispatchers, orgs] = await Promise.all([
    findQuoteFollowers(quotes),
    isDriver ? Promise.resolve(new Map<string, { id: string } | null>()) : loadDispatchers(loads),
    orgIds.length
      ? Organization.find({ _id: { $in: orgIds } }).select("_id name").lean<Array<{ _id: unknown; name?: string }>>()
      : Promise.resolve([]),
  ]);
  const dealerById = new Map(orgs.map((org) => [toId(org._id), String(org.name ?? "").trim()]));

  const visible: Array<{ thread: InboxThread; load: ChatLoad; quote: InboxQuote; customerName: string; state: ShipmentChatState }> = [];
  for (const thread of threads) {
    const load = loadById.get(toId(thread.loadId));
    const quote = quoteById.get(toId(thread.quoteId));
    if (!load || !quote) continue;
    // The thread's load still comes from that quote, at the same dealership.
    if (toId(load.quoteId) !== String(quote._id) || toId(quote.organizationId) !== String(load.organizationId)) continue;
    if (!isDriver && String(load.organizationId) !== orgId) continue;

    // The same customer still follows the shipment (not unlinked, same account).
    const follower = followers.get(String(quote._id));
    if (!follower || follower.id !== toId(thread.customerId)) continue;

    const isReceived = received.has(String(load._id));
    let state: ShipmentChatState;
    if (isDriver) {
      state = driverChatState(load, now, isReceived);
      if (toId(load.assignedDriverId) !== viewerId || state.participantId !== viewerId) continue;
    } else {
      if (dispatchers.get(String(load._id))?.id !== viewerId) continue;
      state = dispatcherChatState(viewerId, Boolean(thread.closedAt), isReceived);
    }
    visible.push({ thread, load, quote, customerName: follower.name || "Customer", state });
  }
  if (visible.length === 0) return EMPTY;

  const counts = await ShipmentChatMessage.aggregate<{ _id: mongoose.Types.ObjectId; n: number }>([
    {
      $match: {
        threadId: { $in: visible.map(({ thread }) => thread._id) },
        readBy: { $ne: new mongoose.Types.ObjectId(viewerId) },
      },
    },
    { $group: { _id: "$threadId", n: { $sum: 1 } } },
  ]);
  const unreadByThread = new Map(counts.map((row) => [String(row._id), row.n]));

  const chats = visible.map(({ thread, load, quote, customerName, state }): CustomerChatInboxItem => ({
    loadId: String(load._id),
    threadId: String(thread._id),
    kind,
    customerName,
    vehicleName: String(quote.vehicleName ?? "").trim(),
    loadNumber: String(load.loadNumber ?? ""),
    dealerName: dealerById.get(String(load.organizationId)) ?? "",
    lastMessageAt: thread.lastMessageAt ? new Date(thread.lastMessageAt).toISOString() : null,
    lastMessagePreview: String(thread.lastMessagePreview ?? ""),
    lastMessageMine: toId(thread.lastMessageSenderId) === viewerId,
    unread: unreadByThread.get(String(thread._id)) ?? 0,
    open: state.open,
  }));
  return { chats, unreadTotal: chats.reduce((sum, chat) => sum + chat.unread, 0) };
}

/**
 * Unread customer chat messages for the Dispatch Chat badges. Never throws: a
 * problem here must not hide the dispatcher↔driver count it's shown with.
 */
export async function customerChatUnreadTotal(actor: { _id: unknown; role?: string }, organizationId: unknown): Promise<number> {
  try {
    return (await listCustomerChatInbox(actor, organizationId)).unreadTotal;
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : "unknown" }, "[ShipmentChatInbox] Unread count unavailable");
    return 0;
  }
}
