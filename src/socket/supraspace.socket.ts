/**
 * supraspace.socket.ts
 *
 * JWT secret chain mirrors crmAuth.middleware.ts exactly:
 *   process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key'
 *
 * Token payload shape (set by generateCrmToken):
 *   { id: userId, type: 'crm' }
 *
 * Socket path: /socket/supraspace
 *
 * ── Events emitted TO client:
 *   message:new        { conversationId, message }
 *   message:deleted    { conversationId, messageId }
 *   conversation:new   { conversation }
 *   presence:update    { userId, status: 'online' | 'offline' }
 *   typing:start       { conversationId, userId, fullName }
 *   typing:stop        { conversationId, userId }
 *   messages:read      { conversationId, userId }
 *
 * ── Events received FROM client:
 *   join:conversation  { conversationId }
 *   leave:conversation { conversationId }
 *   typing:start       { conversationId }
 *   typing:stop        { conversationId }
 *   mark:read          { conversationId }
 */

import { Server as HttpServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import CrmUser from '../models/CrmUser.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import logger from '../utils/logger';

let io: IOServer;

// ── Mirrors crmAuth.middleware.ts secret resolution exactly ──────────────────
const CRM_JWT_SECRET =
  process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key';

// ── Parse allowed origins from your existing CORS_ORIGIN env var ─────────────
function getCorsOrigins(): string | string[] {
  const raw = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '*';
  if (raw === '*') return '*';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initSupraSpaceSocket(server: HttpServer): IOServer {
  io = new IOServer(server, {
    cors: {
      origin: getCorsOrigins(),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    path: '/socket/supraspace',
  });

  // ── Auth middleware ───────────────────────────────────────────────────────
  io.use(async (socket: Socket, next) => {
    try {
      // Accept token from socket auth object or Authorization header
      const token =
        socket.handshake.auth?.token ||
        (socket.handshake.headers?.authorization as string | undefined)
          ?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('CRM authentication required'));
      }

      // Verify with the exact same secret chain as crmAuth.middleware.ts
      const decoded = jwt.verify(token, CRM_JWT_SECRET) as {
        id: string;     // ← crmAuth uses 'id', not 'userId'
        type: string;
      };

      // Enforce crm token type — same check as the middleware
      if (decoded.type !== 'crm') {
        return next(new Error('Invalid CRM token type'));
      }

      // Load user
      const user = await CrmUser.findById(decoded.id).select(
        'fullName username avatar role isActive'
      );

      if (!user) return next(new Error('CRM user not found'));
      if (!user.isActive) return next(new Error('CRM account is deactivated'));

      (socket as any).crmUser = user;
      next();
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        return next(new Error('CRM session expired. Please log in again.'));
      }
      logger.error(err, '[SupraSpace Socket] Auth error');
      next(new Error('Invalid CRM token'));
    }
  });

  // ── Connection handler ────────────────────────────────────────────────────
  io.on('connection', (socket: Socket) => {
    const user = (socket as any).crmUser;
    const userId = user._id.toString();

    // Join personal room — used by controller to push targeted events
    socket.join(`user:${userId}`);

    // Announce online presence to all connected clients
    io.emit('presence:update', { userId, status: 'online' });

    logger.info({ userId, fullName: user.fullName }, '[SupraSpace] User connected');

    // ── Join a conversation room ──────────────────────────────────────────
    socket.on('join:conversation', ({ conversationId }: { conversationId: string }) => {
      socket.join(`conv:${conversationId}`);
    });

    // ── Leave a conversation room ─────────────────────────────────────────
    socket.on('leave:conversation', ({ conversationId }: { conversationId: string }) => {
      socket.leave(`conv:${conversationId}`);
    });

    // ── Typing: start ─────────────────────────────────────────────────────
    socket.on('typing:start', ({ conversationId }: { conversationId: string }) => {
      socket.to(`conv:${conversationId}`).emit('typing:start', {
        conversationId,
        userId,
        fullName: user.fullName,
      });
    });

    // ── Typing: stop ──────────────────────────────────────────────────────
    socket.on('typing:stop', ({ conversationId }: { conversationId: string }) => {
      socket.to(`conv:${conversationId}`).emit('typing:stop', {
        conversationId,
        userId,
      });
    });

    // ── Mark messages as read ─────────────────────────────────────────────
    socket.on('mark:read', async ({ conversationId }: { conversationId: string }) => {
      try {
        await SupraSpaceMessage.updateMany(
          { conversationId, readBy: { $ne: user._id } },
          { $addToSet: { readBy: user._id } }
        );
        socket.to(`conv:${conversationId}`).emit('messages:read', {
          conversationId,
          userId,
        });
      } catch (err: any) {
        logger.error(err, '[SupraSpace] mark:read error');
      }
    });

    // ── Disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      io.emit('presence:update', { userId, status: 'offline' });
      logger.info({ userId, reason }, '[SupraSpace] User disconnected');
    });
  });

  logger.info('[SupraSpace] Socket.io initialized on path /socket/supraspace');
  return io;
}

// ── Singleton getter — used by the controller to emit events ─────────────────
export function getIO(): IOServer {
  if (!io) {
    throw new Error(
      '[SupraSpace] Socket.io not initialized. ' +
      'Call initSupraSpaceSocket(httpServer) before using getIO().'
    );
  }
  return io;
}