import { Server as HttpServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import CrmUser from '../models/CrmUser.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import config from '../config';
import logger from '../utils/logger';

let io: IOServer;

// Track the number of active socket connections per CRM user so that
// a user with multiple tabs/sockets (page + context popup) is only
// marked offline once the LAST connection closes.
const onlineUsers = new Map<string, number>();

// ── Mirrors crmAuth.middleware.ts secret resolution exactly ──────────────────
const CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key';

// ── Parse allowed origins from centralized config ────────────────────────────
function getCorsOrigins(): string | string[] {
  const raw = config.corsOrigin || '*';
  if (raw === '*') return '*';
  return raw.split(',').map((s: string) => s.trim()).filter(Boolean);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initSupraSpaceSocket(server: HttpServer): IOServer {
  io = new IOServer(server, {
    cors: {
      origin: (origin, callback) => {
        const allowed = getCorsOrigins();
        
        // Allow requests with no origin (e.g. mobile apps, curl)
        if (!origin) return callback(null, true);

        // Allow any origin in development mode to match server.ts behavior
        if (config.env === 'development') return callback(null, true);

        // Check against allowed list
        if (Array.isArray(allowed)) {
          if (allowed.includes(origin) || allowed.includes('*')) {
            return callback(null, true);
          }
        } else if (allowed === '*' || allowed === origin) {
          return callback(null, true);
        }

        logger.warn({ origin }, '[SupraSpace Socket] CORS blocked');
        callback(new Error('Not allowed by CORS'));
      },
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

    // Join org room — used for org-wide broadcasts (feed announcements, milestone alerts)
    if (user.organizationId) {
      socket.join(`org:${user.organizationId.toString()}`);
    }

    // Track connection count and announce online presence
    const prevCount = onlineUsers.get(userId) || 0;
    onlineUsers.set(userId, prevCount + 1);
    if (prevCount === 0) {
      // First connection for this user — announce to everyone
      io.emit('presence:update', { userId, status: 'online' });
    }

    logger.info({ userId, fullName: user.fullName }, '[SupraSpace] User connected');

    // ── Presence sync — send the current online roster to the requesting socket ─
    socket.on('presence:request', () => {
      socket.emit('presence:sync', Array.from(onlineUsers.keys()));
    });

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
      const remaining = (onlineUsers.get(userId) || 1) - 1;
      if (remaining <= 0) {
        onlineUsers.delete(userId);
        // Only emit offline when the last connection for this user closes.
        // Each user has two socket connections (page socket + context popup socket),
        // so we must not mark them offline when just one of them disconnects.
        io.emit('presence:update', { userId, status: 'offline' });
      } else {
        onlineUsers.set(userId, remaining);
      }
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