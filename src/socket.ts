import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import config from './config';
import logger from './utils/logger';

interface AuthSocket extends Socket {
  userId?: string;
  organizationId?: string;
  role?: string;
}

export const setupSocket = (io: Server) => {
  // Authentication middleware
  io.use(async (socket: AuthSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      // Verify token — try main app JWT first, then CRM JWT
      let decoded: any;
      try {
        decoded = jwt.verify(token, config.jwt.accessSecret) as any;
        socket.userId = decoded.sub;
        socket.organizationId = decoded.orgId;
        socket.role = decoded.role;
      } catch {
        try {
          const CRM_SECRET = config.jwt.crmJwtSecret || 'crm-secret-key';
          decoded = jwt.verify(token, CRM_SECRET) as any;
          socket.userId = decoded.id; // CRM tokens use 'id', not 'sub'
          socket.role = 'crm';
        } catch (crmErr: any) {
          if (config.env === 'development') {
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

    // Disconnect
    socket.on('disconnect', () => {
      logger.info({ userId: socket.userId }, 'Socket disconnected');
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
