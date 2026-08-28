import { emitToOrg, emitToUser } from "../utils/socketEmitter";

/**
 * Real-time fan-out for calendar changes.
 *
 * Both the Appointment Page calendar tab and Suprah Calendar subscribe to
 * the same tenant room, so a change made in either UI is pushed to both
 * instantly. The payload always carries the full item (or the id on delete)
 * so clients can update local state without a refetch.
 *
 * Delegates to the app's existing Socket.io singleton (utils/socketEmitter.ts,
 * wired once at boot via setSocketIO(io) in server.ts) instead of keeping a
 * separate, never-initialised io reference — every authenticated socket
 * already joins `org:{id}` / `user:{id}` rooms via socket.ts, so this just
 * reuses that existing fan-out rather than bootstrapping a second one.
 */

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
  emitToOrg(orgId, event, payload);
}

/** Direct ping to specific users (assignee notifications). */
export function emitToUsers(
  userIds: string[],
  event: string,
  payload: unknown
): void {
  userIds.forEach((id) => emitToUser(id, event, payload));
}
