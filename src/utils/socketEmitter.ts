import { Server } from 'socket.io';

let io: Server | null = null;

// In-memory set of CRM user IDs with an active socket connection.
// Used by getAgentStatus to show "Online" for users with the CRM open,
// even if their tray app is not running.
const crmOnlineUserIds = new Set<string>();

export function setSocketIO(instance: Server) {
  io = instance;
}

export function getSocketIO(): Server | null {
  return io;
}

export function emitToUser(userId: string, event: string, data: any) {
  if (!io) return;
  io.to(`user:${userId}`).emit(event, data);
}

export function emitToOrg(orgId: string, event: string, data: any) {
  if (!io) return;
  io.to(`org:${orgId}`).emit(event, data);
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

export function addCrmOnlineUser(userId: string) {
  crmOnlineUserIds.add(userId);
}

export function removeCrmOnlineUser(userId: string) {
  crmOnlineUserIds.delete(userId);
}

export function isCrmUserOnline(userId: string): boolean {
  return crmOnlineUserIds.has(userId);
}
