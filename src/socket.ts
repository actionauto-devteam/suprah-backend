import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import config from './config';

interface AuthSocket extends Socket {
  userId?: string;
  organizationId?: string;
}

export const setupSocket = (io: Server) => {
  // Authentication middleware
  io.use(async (socket: AuthSocket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      // Verify token (adjust based on your auth system - JWT or Clerk)
      // For Clerk, you might need to verify differently
      try {
        const decoded = jwt.verify(token, config.jwt.accessSecret) as any;
        socket.userId = decoded.userId;
        socket.organizationId = decoded.organizationId;
      } catch (jwtError) {
        // If JWT verification fails, still allow connection in development
        if (config.env === 'development') {
          console.log('Socket auth: Using development mode, allowing connection');
          socket.userId = 'dev-user';
          return next();
        }
        throw jwtError;
      }

      console.log(`Socket authenticated: ${socket.userId}`);
      next();
    } catch (error) {
      console.error('Socket authentication failed:', error);
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket: AuthSocket) => {
    console.log(`User connected: ${socket.userId}`);

    // Join user's personal room
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
    }

    // Join conversation room
    socket.on('join_conversation', (conversationId: string) => {
      socket.join(`conversation:${conversationId}`);
      console.log(`User ${socket.userId} joined conversation ${conversationId}`);
    });

    // Leave conversation room
    socket.on('leave_conversation', (conversationId: string) => {
      socket.leave(`conversation:${conversationId}`);
      console.log(`User ${socket.userId} left conversation ${conversationId}`);
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
      console.log(`User disconnected: ${socket.userId}`);
    });
  });

  console.log('Socket.io initialized');

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