import { Server } from 'socket.io';
import { resolveCrmUserIdByEmail } from './presenceBridge';

let io: Server | null = null;
let supraSpaceIo: Server | null = null;

const crmOnlineUserIds = new Set<string>();

export function setSocketIO(instance: Server) {
  io = instance;
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

export function emitToOrg(orgId: string, event: string, data: any) {
  io?.to(`org:${orgId}`).emit(event, data);
  supraSpaceIo?.to(`org:${orgId}`).emit(event, data);
}

export function streamLogToAdmins(log: any) {
  if (!io) return;
  io.to('admin:monitoring').emit('system:log:new', log);
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
