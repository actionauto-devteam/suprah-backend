import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import config from './config';
import logger from './utils/logger';
import User from './models/User.model';
import PresenceEvent from './models/PresenceEvent.model';
import CrmUser from './models/CrmUser.model';
import { addCrmOnlineUser, removeCrmOnlineUser, emitToShiftBoard, emitPresenceUpdate } from './utils/socketEmitter';

interface AuthSocket extends Socket {
  userId?: string;
  organizationId?: string;
  role?: string;
}

export const setupSocket = (io: Server) => {
  io.use(async (socket: AuthSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      let decoded: any;
      try {
        decoded = jwt.verify(token, config.jwt.accessSecret) as any;
        const tokenUserId = String(decoded?.sub ?? "").trim();
        if (!tokenUserId) {
          throw new Error("Authentication error: Invalid user token");
        }

        // Socket room membership is derived from the current database user,
        // not stale role/org claims carried by an older JWT.
        const currentUser: any = await User.findById(tokenUserId)
          .select("_id role organizationId isActive")
          .lean();
        if (!currentUser || currentUser.isActive === false) {
          throw new Error("Authentication error: Account unavailable");
        }

        socket.userId = String(currentUser._id);
        socket.role = String(currentUser.role || "");
        socket.organizationId =
          socket.role === "super_admin" && decoded?.orgId
            ? String(decoded.orgId)
            : currentUser.organizationId
              ? String(currentUser.organizationId)
              : undefined;
      } catch {
        try {
          const CRM_SECRET = config.jwt.crmJwtSecret || 'crm-secret-key';
          decoded = jwt.verify(token, CRM_SECRET) as any;
          socket.userId = decoded.id;
          socket.role = 'crm';
        } catch (crmErr: any) {
          if (config.env === 'development' && process.env.ALLOW_INSECURE_SOCKET_DEV_FALLBACK === 'true') {
            logger.warn('Socket auth: dev fallback active');
            socket.userId = 'dev-user';
            socket.role = 'super_admin';
            return next();
          }
          throw crmErr;
        }
      }

      logger.debug({ userId: socket.userId, role: socket.role }, 'Socket authenticated');
      next();
    } catch (error) {
      logger.error(error, 'Socket authentication failed');
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket: AuthSocket) => {
    logger.info({ userId: socket.userId }, 'Socket connected');

    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
    }

    if (socket.organizationId) {
      socket.join(`org:${socket.organizationId}`);
    }

    // Tray-app connections identify themselves via clientType so we can push
    // an instant "check for update" signal to every running tray at once,
    // separate from the per-user/per-org rooms above.
    if (socket.handshake.auth?.clientType === 'tray') {
      socket.join('tray-clients');
    }

    // CRM presence tracking: mark online + join shift-board room if admin/manager
    if (socket.role === 'crm' && socket.userId) {
      addCrmOnlineUser(socket.userId);
      CrmUser.findById(socket.userId).select('role fullName organizationId').lean()
        .then((crmUser: any) => {
          if (!crmUser) return;
          if (['admin', 'manager'].includes(crmUser.role)) {
            socket.join('crm:shift-board');
          }
          // Join org room so CRM staff receive org-wide real-time events
          if (crmUser.organizationId) {
            socket.join(`org:${crmUser.organizationId}`);
          }
          emitToShiftBoard('crm:presence', { userId: socket.userId, online: true });
        })
        .catch(() => {});
    }

    // Allow any CRM user to manually join the shift-board room (Live Shift Board page)
    socket.on('join_shift_board', () => {
      socket.join('crm:shift-board');
    });
    socket.on('leave_shift_board', () => {
      socket.leave('crm:shift-board');
    });

    // --- Admin Monitoring Room ---
    socket.on('join_system_monitoring', () => {
      if (socket.role === 'super_admin') {
        socket.join('admin:monitoring');
        logger.info({ userId: socket.userId }, 'Admin joined system monitoring');
        socket.emit('monitoring_status', { joined: true });
      } else {
        logger.warn({ userId: socket.userId, role: socket.role }, 'Unauthorized attempt to join monitoring');
        socket.emit('monitoring_error', { message: 'Unauthorized: Super Admin role required' });
      }
    });

    socket.on('leave_system_monitoring', () => {
      socket.leave('admin:monitoring');
      logger.info({ userId: socket.userId }, 'Admin left system monitoring');
      socket.emit('monitoring_status', { joined: false });
    });
    // ----------------------------

    // --- Admin Review Queue Room ---
    socket.on('join_review_queue', () => {
      if (socket.role === 'super_admin') {
        socket.join('admin:review-queue');
        socket.emit('review_queue_status', { joined: true });
      } else {
        socket.emit('review_queue_error', { message: 'Unauthorized: Super Admin role required' });
      }
    });

    socket.on('leave_review_queue', () => {
      socket.leave('admin:review-queue');
      socket.emit('review_queue_status', { joined: false });
    });
    // ----------------------------

    socket.on('join_shipment_tracking', (shipmentId: string) => {
      if (shipmentId) {
        socket.join(`shipment:${shipmentId}`);
      }
    });

    socket.on('leave_shipment_tracking', (shipmentId: string) => {
      if (shipmentId) {
        socket.leave(`shipment:${shipmentId}`);
      }
    });

    socket.on('join_conversation', (conversationId: string) => {
      socket.join(`conversation:${conversationId}`);
      logger.debug({ userId: socket.userId, conversationId }, 'User joined conversation');
    });

    // Leave conversation room
    socket.on('leave_conversation', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      logger.debug({ userId: socket.userId, conversationId }, 'User left conversation');
    });

    // Typing indicators
    socket.on('typing_start', (data: { conversationId: string }) => {
      socket.to(`conversation:${data.conversationId}`).emit('user_typing', {
        userId: socket.userId,
        conversationId: data.conversationId,
        typing: true,
      });
    });

    socket.on('typing_stop', (data: { conversationId: string }) => {
      socket.to(`conversation:${data.conversationId}`).emit('user_typing', {
        userId: socket.userId,
        conversationId: data.conversationId,
        typing: false,
      });
    });

    // Mark message as read
    socket.on('mark_read', (data: { conversationId: string; messageId: string }) => {
      socket.to(`conversation:${data.conversationId}`).emit('message_read', {
        userId: socket.userId,
        conversationId: data.conversationId,
        messageId: data.messageId,
      });
    });

    socket.on('disconnect', async () => {
      logger.info({ userId: socket.userId }, 'Socket disconnected');
      if (socket.role === 'crm' && socket.userId) {
        removeCrmOnlineUser(socket.userId);
        emitToShiftBoard('crm:presence', { userId: socket.userId, online: false });
      }
      if (socket.userId) {
        try {
          // A socket.io room reflects sockets that are STILL connected (this socket has
          // already left it by the time 'disconnect' fires) — so if the user has another
          // tab/device open, skip touching presence entirely; that device owns it now.
          const room = io.sockets.adapter.rooms.get(`user:${socket.userId}`);
          if (room && room.size > 0) return;

          const user = await User.findById(socket.userId).select('onlineStatus statusIsManual organizationId name avatar email').lean();
          if (user && !user.statusIsManual) {
            await User.findByIdAndUpdate(socket.userId, { onlineStatus: 'offline' });
            const orgId = socket.organizationId || user.organizationId?.toString();
            if (orgId) {
              await emitPresenceUpdate(orgId, {
                userId: socket.userId,
                email: user.email,
                onlineStatus: 'offline',
                lastActive: new Date().toISOString(),
              });
              try {
                const event = await PresenceEvent.create({
                  organizationId: orgId,
                  userId: socket.userId,
                  userName: user.name,
                  userAvatar: user.avatar,
                  type: 'offline',
                  description: `${user.name} went Offline`,
                });
                io.to(`org:${orgId}`).emit('activity:new', event);
              } catch (evErr) {
                logger.warn(evErr, 'Failed to log disconnect presence event');
              }
            }
          }
        } catch (err) {
          logger.error(err, 'Failed to mark user offline on disconnect');
        }
      }
    });
  });

  logger.info('Socket.io initialized');

  return io;
};

// Helper function to emit to specific user
export const emitToUser = (io: Server, userId: string, event: string, data: any) => {
  io.to(`user:${userId}`).emit(event, data);
};

// Helper function to emit to conversation
export const emitToConversation = (io: Server, conversationId: string, event: string, data: any) => {
  io.to(`conversation:${conversationId}`).emit(event, data);
};