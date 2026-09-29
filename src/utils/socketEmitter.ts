import { Server } from 'socket.io';
import { resolveCrmUserIdByEmail } from './presenceBridge';

let io: Server | null = null;
let supraSpaceIo: Server | null = null;

const crmOnlineUserIds = new Set<string>();

export function setSocketIO(instance: Server) {
  io = instance;
}

/**
 * Drops a user's live socket connections. Rooms (org:*, user:*) are joined at
 * connect time, so after an access change (removed from an organization,
 * suspended, role changed) the client reconnects and rooms are rebuilt from
 * the user's current access instead of receiving stale organization events.
 */
export function disconnectUserSockets(userId: unknown): void {
  const id = String(userId ?? '').trim();
  const io = getSocketIO();
  if (!io || !id) return;
  try {
    io.in(`user:${id}`).disconnectSockets(true);
  } catch {
    // Best effort: the next reconnect re-validates access anyway.
  }
}

export function getSocketIO(): Server | null {
  return io;
}

export function setSupraSpaceSocketIO(instance: Server) {
  supraSpaceIo = instance;
}

export interface PresenceUpdatePayload {
  userId: string;
  email?: string;
  onlineStatus?: string;
  customStatus?: string | null;
  lastActive?: string;
  lastDeviceType?: string | null;
  statusExpiresAt?: string | null;
}

// Single presence broadcast point for the whole system: emits on the main org-wide socket
// (TeamPulse, profile, header, etc.) and — best-effort, matched by email — relays the same
// update onto the SupraSpace socket keyed by the recipient's CrmUser id, since SupraSpace
// members are identified by CrmUser, not User. See utils/presenceBridge.ts.
export async function emitPresenceUpdate(orgId: string, payload: PresenceUpdatePayload) {
  if (io) io.to(`org:${orgId}`).emit('presence_update', payload);
  if (supraSpaceIo && payload.email) {
    try {
      const crmUserId = await resolveCrmUserIdByEmail(payload.email, orgId);
      if (crmUserId) {
        supraSpaceIo.to(`org:${orgId}`).emit('presence_update', { ...payload, userId: crmUserId });
      }
    } catch {
      // Best-effort — the primary (main-site) broadcast already succeeded.
    }
  }
}

export function emitToUser(userId: string, event: string, data: any) {
  io?.to(`user:${userId}`).emit(event, data);
  supraSpaceIo?.to(`user:${userId}`).emit(event, data);
}

/**
 * Emit on the main Socket.IO server to the recipient's CRM identity room.
 * This room is deliberately separate from user:{User._id}: the dashboard's
 * shared socket can safely join both identities without CRM notifications
 * being mistaken for main-account notifications.
 *
 * SupraSpace keeps its existing user:{CrmUser._id} event contract; callers
 * that need backward-compatible SupraSpace delivery should continue emitting
 * the legacy event through emitToUser in addition to this CRM-specific one.
 */
export function emitToCrmUser(userId: string, event: string, data: any) {
  io?.to(`crm-user:${userId}`).emit(event, data);
}

export function emitToOrg(orgId: string, event: string, data: any) {
  io?.to(`org:${orgId}`).emit(event, data);
  supraSpaceIo?.to(`org:${orgId}`).emit(event, data);
}

// Staff sockets showing the shared driver pool ('join_driver_pool' in socket.ts).
export const DRIVER_POOL_ROOM = 'driver-pool:staff';

// A driver's Work Availability or new-work eligibility changed. Carries the
// driver id only; each dispatcher re-reads the details through the API.
export function emitDriverPoolChange(driverId: string) {
  if (!io) return;
  io.to(DRIVER_POOL_ROOM).emit('driver:directory_changed', { driverId });
}

export function streamLogToAdmins(log: any) {
  if (!io) return;
  io.to('admin:monitoring').emit('system:log:new', log);
}

// Unified review-queue claim/release broadcasts — see 'admin:review-queue'
// room join in socket.ts (mirrors the 'admin:monitoring' pattern above).
export function emitReviewQueueChange(data: any) {
  if (!io) return;
  io.to('admin:review-queue').emit('review-queue:claim-changed', data);
}

// Emit an event to all admin/manager Live Shift Board watchers
export function emitToShiftBoard(event: string, data: any) {
  if (!io) return;
  io.to('crm:shift-board').emit(event, data);
}

// Emit an event to every currently-connected tray-app instance, regardless of
// which user/org they belong to — used to push an instant "check for update
// now" signal the moment a new tray release is published, instead of every
// tray waiting for its own next periodic poll.
export function emitToTrayClients(event: string, data: any) {
  if (!io) return;
  io.to('tray-clients').emit(event, data);
}

export function addCrmOnlineUser(userId: string) {
  crmOnlineUserIds.add(userId);
}

export function removeCrmOnlineUser(userId: string) {
  crmOnlineUserIds.delete(userId);
}

export function isCrmUserOnline(userId: string): boolean {
  return crmOnlineUserIds.has(userId);
}