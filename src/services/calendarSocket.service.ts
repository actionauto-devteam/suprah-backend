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
let warnedOnce = false;
export const setCalendarIO = (io: Server) => {
  ioRef = io;
};
/**
 * Fail-soft accessor: broadcasting is an enhancement, never a dependency.
 * If setCalendarIO(io) hasn't been called yet, mutations still succeed and
 * a single warning is logged instead of throwing (which would turn every
 * successful save into a 500).
 */
const getIO = (): Server | null => {
  if (!ioRef && !warnedOnce) {
    warnedOnce = true;
    console.warn(
      "[calendar] Socket.io not initialised — real-time sync inactive. " +
        "Call setCalendarIO(io) in the socket bootstrap to enable it."
    );
  }
  return ioRef;
};

const tenantRoom = (orgId: string) => `org:${orgId}`;
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
  orgId: string,
  payload:
    | { source: "calendarEvent" | "appointment"; item: unknown }
    | { source: "calendarEvent" | "appointment"; id: string }
): void {
  const io = getIO();
  if (!io) return;
  io.to(tenantRoom(orgId)).emit(event, payload);
}

/** Direct ping to specific users (assignee notifications). */
export function emitToUsers(
  userIds: string[],
  event: string,
  payload: unknown
): void {
  const io = getIO();
  if (!io) return;
  userIds.forEach((id) => io.to(userRoom(id)).emit(event, payload));
}

/**
 * Optional: room registration on connection, if not already handled
 * by your existing socket auth layer.
 */
export function registerCalendarSocket(io: Server): void {
  setCalendarIO(io);
  io.on("connection", (socket) => {
    const { orgId, userId } = socket.data ?? {};
    if (orgId) socket.join(tenantRoom(String(orgId)));
    if (userId) socket.join(userRoom(String(userId)));
  });
}
