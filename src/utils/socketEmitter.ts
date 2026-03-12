import { Server } from 'socket.io';

let io: Server | null = null;

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
