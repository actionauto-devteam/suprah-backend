import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import CrmUser from '../models/CrmUser.model';
import { getSocketIO } from '../utils/socketEmitter';

let io: SocketIOServer | null = null;


export function initFeedSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || '*',
      credentials: true,
    },
    path: '/socket.io',
  });

  io.use(async (socket: Socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) return next(new Error('Authentication required'));

      const secret = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || '';
      const decoded = jwt.verify(token, secret) as { id: string };

      const user = await CrmUser.findById(decoded.id).select('_id organizationId role isActive');
      if (!user || !user.isActive) return next(new Error('User not found or inactive'));

      (socket as any).crmUser = user;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).crmUser;

    if (!user?.organizationId) {
      socket.disconnect();
      return;
    }

    const orgRoom = `org:${user.organizationId.toString()}`;
    // Per-user room — targeted events like `feed:notify` (mentions, comments
    // on your posts, @all announcements) are emitted here so only the
    // intended recipient receives them.
    const userRoom = `user:${user._id.toString()}`;

    socket.join(orgRoom);
    socket.join(userRoom);

    // Clean up when the client disconnects (tab closed, network drop, etc.)
    socket.on('disconnect', () => {
      socket.leave(orgRoom);
      socket.leave(userRoom);
    });
  });

  return io;
}

// ─── Getter ───────────────────────────────────────────────────────────────────

/**
 * Returns the active Socket.IO instance.
 * Throws if `initFeedSocket()` has not been called yet — callers in the
 * feed controller wrap this in try/catch so the REST API is unaffected.
 */
export function getIO(): SocketIOServer {
  const activeIO = io ?? getSocketIO();
  if (!activeIO) throw new Error('Socket.IO not initialised — call initFeedSocket() first');
  return activeIO;
}