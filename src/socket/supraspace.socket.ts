import { Server as HttpServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import CrmUser from '../models/CrmUser.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import config from '../config';
import logger from '../utils/logger';
import { setSupraSpaceSocketIO } from '../utils/socketEmitter';
import { resolvePresenceForCrmRoster } from '../utils/presenceBridge';

let io: IOServer;

const onlineUsers = new Map<string, number>();

const CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key';

function getCorsOrigins(): string | string[] {
  const raw = config.corsOrigin || '*';
  if (raw === '*') return '*';
  return raw.split(',').map((s: string) => s.trim()).filter(Boolean);
}


export function initSupraSpaceSocket(server: HttpServer): IOServer {
  io = new IOServer(server, {
    cors: {
      origin: (origin, callback) => {
        const allowed = getCorsOrigins();
        
        if (!origin) return callback(null, true);

        if (config.env === 'development') return callback(null, true);

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

  io.use(async (socket: Socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ||
        (socket.handshake.headers?.authorization as string | undefined)
          ?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('CRM authentication required'));
      }

      const decoded = jwt.verify(token, CRM_JWT_SECRET) as {
        id: string;
        type: string;
      };

      if (decoded.type !== 'crm') {
        return next(new Error('Invalid CRM token type'));
      }

      const user = await CrmUser.findById(decoded.id).select(
        'fullName username avatar role isActive organizationId email'
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

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).crmUser;
    const userId = user._id.toString();

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

    // ── Real status sync — full org roster's actual online/away/busy/DND status,
    // resolved from the linked main-site User account (see utils/presenceBridge.ts).
    // Distinct from the plain connected/disconnected boolean above.
    socket.on('presence:status_request', async () => {
      try {
        const roster = await CrmUser.find({ organizationId: user.organizationId, isActive: true })
          .select('_id email')
          .lean();
        const presenceMap = await resolvePresenceForCrmRoster(roster);
        socket.emit(
          'presence:status_sync',
          Array.from(presenceMap.entries()).map(([id, p]) => ({ userId: id, ...p })),
        );
      } catch (err: any) {
        logger.error(err, '[SupraSpace] presence:status_request error');
      }
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

  setSupraSpaceSocketIO(io);

  logger.info('[SupraSpace] Socket.io initialized on path /socket/supraspace');
  return io;
}

// ── Online-presence check — used by controller to skip push for live sockets ──
export function isUserOnline(userId: string): boolean {
  return (onlineUsers.get(userId) ?? 0) > 0;
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