import type { Server } from "socket.io";

/**
 * Real-time fan-out for calendar changes.
 *
 * Both the Appointment Page calendar tab and Suprah Calendar subscribe to
 * the same tenant room, so a change made in either UI is pushed to both
 * instantly. The payload always carries the full item (or the id on delete)
 * so clients can update local state without a refetch.
 *
 * ── INTEGRATION ──────────────────────────────────────────────────────────
 * Replace `getIO` below with the accessor from your existing Socket.io
 * bootstrap (the same one the Project Management module uses for its
 * WebSocket notifications). If your server already joins each authenticated
 * socket to a `dealership:{id}` room, delete `registerCalendarSocket` —
 * only the emit helpers are needed.
 * ─────────────────────────────────────────────────────────────────────────
 */

// TODO(integration): import { getIO } from "../sockets/io";
let ioRef: Server | null = null;
export const setCalendarIO = (io: Server) => {
  ioRef = io;
};
const getIO = (): Server => {
  if (!ioRef) throw new Error("Socket.io not initialised for calendar module.");
  return ioRef;
};

const tenantRoom = (dealershipId: string) => `dealership:${dealershipId}`;
const userRoom = (userId: string) => `user:${userId}`;

export type CalendarSocketEvent =
  | "calendar:created"
  | "calendar:updated"
  | "calendar:deleted";

/**
 * Broadcast a calendar mutation to every connected user of the tenant.
 * `source` distinguishes native calendar items from appointments so
 * clients know which slice of local state to touch.
 */
export function emitCalendarChange(
  event: CalendarSocketEvent,
  dealershipId: string,
  payload:
    | { source: "calendarEvent" | "appointment"; item: unknown }
    | { source: "calendarEvent" | "appointment"; id: string }
): void {
  getIO().to(tenantRoom(dealershipId)).emit(event, payload);
}

/** Direct ping to specific users (assignee notifications). */
export function emitToUsers(
  userIds: string[],
  event: string,
  payload: unknown
): void {
  const io = getIO();
  userIds.forEach((id) => io.to(userRoom(id)).emit(event, payload));
}

/**
 * Optional: room registration on connection, if not already handled
 * by your existing socket auth layer.
 */
export function registerCalendarSocket(io: Server): void {
  setCalendarIO(io);
  io.on("connection", (socket) => {
    const { dealershipId, userId } = socket.data ?? {};
    if (dealershipId) socket.join(tenantRoom(String(dealershipId)));
    if (userId) socket.join(userRoom(String(userId)));
  });
}
