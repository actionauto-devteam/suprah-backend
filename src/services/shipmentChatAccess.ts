/*
 * Who is in a shipment's customer chats, and when each chat is open (decided
 * 2026-11-05). Pure, so the rules are testable without a database.
 *
 * Every shipment a customer follows on My Shipments has two private chats:
 * - customer ↔ the driver carrying the car: from the moment that driver
 *   accepts the load until 24 hours after delivery;
 * - customer ↔ the load's dispatcher (the one it was handed to, otherwise
 *   whoever created it, otherwise the dealership's admin): from booking until
 *   the dispatcher closes it.
 * Only the CURRENT driver and dispatcher are in a chat. When the load changes
 * hands, the old one loses access at once and the new one starts with an
 * empty chat. Loads made without a quote have no customer, so no chat.
 */

import { SUPPORT_EMAIL } from "../utils/userMessages";

export const SHIPMENT_CHAT_KINDS = ["driver", "dispatcher"] as const;
export type ShipmentChatKind = (typeof SHIPMENT_CHAT_KINDS)[number];

export function isShipmentChatKind(value: unknown): value is ShipmentChatKind {
  return typeof value === "string" && (SHIPMENT_CHAT_KINDS as readonly string[]).includes(value);
}

/**
 * How customers see the dispatcher: first name only, always shown with the
 * dealership's name. Staff and drivers see full names.
 */
export function customerFacingDispatcherName(name: string | null | undefined): string {
  return (name ?? "").trim().split(/\s+/)[0] || "Dispatcher";
}

/** The driver chat stays open this long after delivery, for last questions. */
export const DRIVER_CHAT_AFTER_DELIVERY_MS = 24 * 60 * 60 * 1000;

/** The load statuses where the driver has accepted and the driver chat is possible. */
const DRIVER_CHAT_STATUSES = new Set(["Accepted", "Picked Up", "In-Transit", "Delivered"]);

export type ShipmentChatClosedReason =
  /** Both chats: the shipment isn't booked yet (no load). */
  | "not_booked"
  /** Driver chat: no driver has accepted the load yet (or one handed it back). */
  | "no_driver_yet"
  /** Driver chat: more than 24 hours since delivery. */
  | "delivered"
  /** Driver chat: the load was cancelled. */
  | "cancelled"
  /** Dispatcher chat: nobody at the dealership can take messages. */
  | "no_dispatcher"
  /** Dispatcher chat: the dispatcher closed it. */
  | "closed_by_dispatcher"
  /** Both chats: the customer confirmed they received the vehicle. */
  | "received";

export interface ShipmentChatState {
  /** Messages can be sent. */
  open: boolean;
  /** The driver or dispatcher in this chat right now, or null. */
  participantId: string | null;
  reason: ShipmentChatClosedReason | null;
  /** Driver chat after delivery: when it closes. */
  closesAt: string | null;
}

export interface ChatLoad {
  status?: unknown;
  assignedDriverId?: unknown;
  deliveredAt?: unknown;
}

const idOf = (value: unknown) => {
  const id = String(value ?? "").trim();
  return /^[a-f0-9]{24}$/i.test(id) ? id : null;
};

const timeOf = (value: unknown) => {
  if (!value) return null;
  const time = new Date(value as string | Date).getTime();
  return Number.isFinite(time) ? time : null;
};

const closed = (reason: ShipmentChatClosedReason, participantId: string | null = null): ShipmentChatState => ({
  open: false,
  participantId,
  reason,
  closesAt: null,
});

/**
 * The customer ↔ driver chat for this load right now. It closes 24 hours
 * after delivery, or as soon as the customer confirms they received the
 * vehicle (`received`), whichever comes first.
 */
export function driverChatState(load: ChatLoad, now = Date.now(), received = false): ShipmentChatState {
  const status = String(load.status ?? "");
  const driverId = idOf(load.assignedDriverId);
  if (status === "Cancelled") return closed("cancelled", driverId);
  if (!driverId || !DRIVER_CHAT_STATUSES.has(status)) return closed("no_driver_yet");
  if (received) return closed("received", driverId);
  if (status === "Delivered") {
    const deliveredAt = timeOf(load.deliveredAt);
    const closesAt = deliveredAt === null ? null : deliveredAt + DRIVER_CHAT_AFTER_DELIVERY_MS;
    if (closesAt === null || now >= closesAt) return closed("delivered", driverId);
    return { open: true, participantId: driverId, reason: null, closesAt: new Date(closesAt).toISOString() };
  }
  return { open: true, participantId: driverId, reason: null, closesAt: null };
}

/**
 * The customer ↔ dispatcher chat for this load right now. `dispatcherId` is
 * the load's current contact (see dispatchChatContact), `closedByDispatcher`
 * whether that dispatcher closed their chat, `received` whether the customer
 * confirmed they received the vehicle (that closes it for good).
 */
export function dispatcherChatState(dispatcherId: unknown, closedByDispatcher = false, received = false): ShipmentChatState {
  const id = idOf(dispatcherId);
  if (!id) return closed("no_dispatcher");
  if (received) return closed("received", id);
  if (closedByDispatcher) return closed("closed_by_dispatcher", id);
  return { open: true, participantId: id, reason: null, closesAt: null };
}

export type ShipmentChatAudience = "customer" | "driver" | "dispatcher";

/**
 * What a closed chat says, in plain English, with what to do instead.
 * `dealerName` names the dealership for customers.
 */
export function shipmentChatClosedNote(
  kind: ShipmentChatKind,
  reason: ShipmentChatClosedReason | null,
  audience: ShipmentChatAudience,
  dealerName?: string,
): string | null {
  if (!reason) return null;
  const dealer = String(dealerName ?? "").trim() || "the dealership";
  if (audience === "customer") {
    switch (reason) {
      case "not_booked":
        return `You can message the dispatcher once ${dealer} books your shipment, and your driver once they accept it.`;
      case "no_driver_yet":
        return "You can message your driver once a driver accepts your shipment. Until then, message the dispatcher.";
      case "delivered":
        return "This chat closed 24 hours after delivery. For anything else, message the dispatcher.";
      case "cancelled":
        return "This shipment was cancelled, so the driver chat is closed. Message the dispatcher with any questions.";
      case "no_dispatcher":
        return `Nobody at ${dealer} can take messages here right now. Try again later. If you need help sooner, contact Suprah AI support at ${SUPPORT_EMAIL}.`;
      case "closed_by_dispatcher":
        return `The dispatcher closed this chat. If you still need help with this shipment, contact Suprah AI support at ${SUPPORT_EMAIL}.`;
      case "received":
        return `You confirmed you received your vehicle, so this chat is closed. If anything isn't right, contact Suprah AI support at ${SUPPORT_EMAIL}.`;
    }
  }
  switch (reason) {
    case "not_booked":
      return "This shipment isn't booked yet.";
    case "no_driver_yet":
      return "The customer can message the driver once a driver accepts the load.";
    case "delivered":
      return kind === "driver"
        ? "This chat closed 24 hours after delivery. You can still read it."
        : "This chat closed 24 hours after delivery.";
    case "cancelled":
      return "The load was cancelled, so the customer's chat with the driver is closed. The dispatcher's chat with the customer stays open.";
    case "no_dispatcher":
      return "Nobody at the dealership can take this customer's messages. An active staff member needs to own this load.";
    case "closed_by_dispatcher":
      return audience === "dispatcher"
        ? "You closed this chat. The customer can read it but can't send messages. Reopen it if they still need you."
        : "The dispatcher closed this chat.";
    case "received":
      return "The customer confirmed they received the vehicle, so this chat is closed. You can still read it.";
  }
  return null;
}
