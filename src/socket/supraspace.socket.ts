import { Server as HttpServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import CrmUser from '../models/CrmUser.model';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import Notification from '../models/Notification.model';
import config from '../config';
import logger from '../utils/logger';
import { setSupraSpaceSocketIO } from '../utils/socketEmitter';
import { resolvePresenceForCrmRoster } from '../utils/presenceBridge';
// Suprah YapLine — PTT voice + screen share signaling rides on this same
// socket connection (no second WebSocket). Handlers are registered per
// connection below; disconnect cleanup removes the user from any live yap
// sessions so a closed tab never leaves a ghost participant.
import { registerYapLineHandlers, handleYapLineDisconnect } from './yapline.socket';

let io: IOServer;

const onlineUsers = new Map<string, number>();

const CRM_JWT_SECRET = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || 'crm-secret-key';

async function isConversationMember(conversationId: string, userId: string): Promise<boolean> {
  if (!conversationId || !userId) return false;
  const conversation = await SupraSpaceConversation.exists({
    _id: conversationId,
    members: userId,
    isActive: true,
  });
  return Boolean(conversation);
}

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

    // Conversations this socket has an outstanding typing:start for, with no
    // typing:stop yet. If the tab closes/crashes/loses connection mid-type,
    // the client's own inactivity timer never fires and other participants
    // are stuck seeing "is typing..." forever — cleaned up on disconnect
    // below. Scoped to this socket, not the user, since one user can have
    // multiple connections (page socket + popup socket) and closing one
    // must not clear typing state still legitimately active on another.
    const activeTypingConversations = new Set<string>();

    // ── Suprah YapLine (PTT voice + screen share) ─────────────────────────
    registerYapLineHandlers(io, socket);

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
    socket.on('join:conversation', async ({ conversationId }: { conversationId: string }) => {
      try {
        if (!(await isConversationMember(conversationId, userId))) {
          logger.warn({ userId, conversationId }, '[SupraSpace] Blocked unauthorized conversation room join');
          socket.emit('conversation:access-denied', { conversationId });
          return;
        }
        socket.join(`conv:${conversationId}`);
      } catch (err: any) {
        logger.error(err, '[SupraSpace] join:conversation authorization error');
      }
    });

    // ── Leave a conversation room ─────────────────────────────────────────
    socket.on('leave:conversation', ({ conversationId }: { conversationId: string }) => {
      socket.leave(`conv:${conversationId}`);
    });

    // ── Typing: start ─────────────────────────────────────────────────────
    socket.on('typing:start', async ({ conversationId }: { conversationId: string }) => {
      if (!(await isConversationMember(conversationId, userId))) {
        logger.warn({ userId, conversationId }, '[SupraSpace] Blocked unauthorized typing:start');
        return;
      }
      activeTypingConversations.add(conversationId);
      socket.to(`conv:${conversationId}`).emit('typing:start', {
        conversationId,
        userId,
        fullName: user.fullName,
      });
    });

    // ── Typing: stop ──────────────────────────────────────────────────────
    socket.on('typing:stop', async ({ conversationId }: { conversationId: string }) => {
      if (!(await isConversationMember(conversationId, userId))) {
        logger.warn({ userId, conversationId }, '[SupraSpace] Blocked unauthorized typing:stop');
        return;
      }
      activeTypingConversations.delete(conversationId);
      socket.to(`conv:${conversationId}`).emit('typing:stop', {
        conversationId,
        userId,
      });
    });

    // ── Mark messages as read ─────────────────────────────────────────────
    socket.on('mark:read', async ({ conversationId }: { conversationId: string }) => {
      try {
        if (!(await isConversationMember(conversationId, userId))) {
          logger.warn({ userId, conversationId }, '[SupraSpace] Blocked unauthorized mark:read');
          return;
        }
        await SupraSpaceMessage.updateMany(
          { conversationId, readBy: { $ne: user._id } },
          { $addToSet: { readBy: user._id } }
        );
        await SupraSpaceConversation.updateOne(
          { _id: conversationId, manualUnreadBy: user._id },
          { $pull: { manualUnreadBy: user._id } }
        );
        // Same gap as getMessages (supraspace.controller.ts) had — a
        // conversation you're already viewing when a message arrives gets
        // marked read entirely through this socket path (no GET request at
        // all), so the Notifications tab needs the sync here too, not just
        // there.
        Notification.updateMany(
          { userId: user._id, type: 'crm_message', 'metadata.conversationId': conversationId, isRead: false },
          { $set: { isRead: true } }
        ).catch(() => {});
        socket.to(`conv:${conversationId}`).emit('messages:read', {
          conversationId,
          userId,
        });
      } catch (err: any) {
        logger.error(err, '[SupraSpace] mark:read error');
      }
    });

    // ── Mark every conversation the user belongs to as read ───────────────
    socket.on('mark:all:read', async () => {
      try {
        const conversations = await SupraSpaceConversation.find({
          members: userId,
          isActive: true,
        }).select('_id').lean();
        const convIds = conversations.map((c) => c._id);
        if (!convIds.length) {
          socket.emit('conversations:all-read', { conversationIds: [] });
          return;
        }
        await SupraSpaceMessage.updateMany(
          { conversationId: { $in: convIds }, readBy: { $ne: user._id } },
          { $addToSet: { readBy: user._id } }
        );
        await SupraSpaceConversation.updateMany(
          { _id: { $in: convIds }, manualUnreadBy: user._id },
          { $pull: { manualUnreadBy: user._id } }
        );
        const idStrings = convIds.map((id) => id.toString());
        Notification.updateMany(
          { userId: user._id, type: 'crm_message', 'metadata.conversationId': { $in: idStrings }, isRead: false },
          { $set: { isRead: true } }
        ).catch(() => {});
        idStrings.forEach((conversationId) => {
          socket.to(`conv:${conversationId}`).emit('messages:read', { conversationId, userId });
        });
        socket.emit('conversations:all-read', { conversationIds: idStrings });
      } catch (err: any) {
        logger.error(err, '[SupraSpace] mark:all:read error');
      }
    });

    // ── Disconnect ────────────────────────────────────────────────────────
    socket.on('disconnect', (reason) => {
      // YapLine first: remove this socket from any live yap sessions so the
      // remaining participants tear down their peer connections immediately.
      try {
        handleYapLineDisconnect(io, socket);
      } catch (err: any) {
        logger.error(err, '[YapLine] disconnect cleanup error');
      }

      // Tell every conversation this socket was mid-typing in to clear the
      // indicator — otherwise a crashed/closed tab leaves other viewers
      // staring at a permanently stuck "is typing..." for this user.
      activeTypingConversations.forEach((conversationId) => {
        socket.to(`conv:${conversationId}`).emit('typing:stop', { conversationId, userId });
      });
      activeTypingConversations.clear();

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