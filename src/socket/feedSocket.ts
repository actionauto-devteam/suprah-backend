/**
 * feedSocket.ts
 * ─────────────
 * Initialises a Socket.IO server and provides a typed `getIO()` helper
 * that the feed controller uses to emit real-time events.
 *
 * ARCHITECTURE
 * ────────────
 * • Every authenticated socket joins a room named `org:<organizationId>`.
 * • Feed events (new / updated / deleted) are emitted only to that room,
 *   so cross-organisation data never leaks through the socket layer.
 *
 * HOW TO PLUG IN
 * ──────────────
 * Call `initFeedSocket(httpServer)` once in your server entry file AFTER
 * creating the HTTP server but BEFORE calling httpServer.listen():
 *
 *   import { createServer } from 'http';
 *   import app from './app';
 *   import { initFeedSocket } from './sockets/feedSocket';
 *
 *   const httpServer = createServer(app);
 *   initFeedSocket(httpServer);   // ← add this
 *   httpServer.listen(PORT);
 *
 * NOTE: If you skip this step the REST API still works normally.
 * Every `getIO()` call in the controller is wrapped in try/catch and
 * silently swallowed if Socket.IO hasn't been initialised yet.
 */

import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import CrmUser from '../models/CrmUser.model';
import { getSocketIO } from '../utils/socketEmitter';

// Module-level singleton — initialised once, reused everywhere via getIO()
let io: SocketIOServer | null = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Attaches a Socket.IO server to the existing HTTP server and configures:
 *  1. CORS (reads CLIENT_URL from env, defaults to wildcard for development)
 *  2. JWT-based authentication middleware applied to every new connection
 *  3. Organisation-scoped rooms so events never bleed across tenants
 */
export function initFeedSocket(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: process.env.CLIENT_URL || '*', // Lock this down in production
      credentials: true,
    },
    path: '/socket.io',
  });

  // ── Per-connection authentication middleware ───────────────────────────────
  // Runs before the 'connection' event fires.
  // Rejects the socket immediately if the token is missing, expired, or
  // belongs to a deactivated user.
  io.use(async (socket: Socket, next) => {
    try {
      // Token can be sent via socket.handshake.auth.token (preferred)
      // or as a standard Authorization header (Bearer <token>)
      const token =
        socket.handshake.auth?.token ||
        socket.handshake.headers?.authorization?.replace('Bearer ', '');

      if (!token) return next(new Error('Authentication required'));

      // Verify the JWT using the same secret as the REST middleware
      const secret = process.env.CRM_JWT_SECRET || process.env.JWT_SECRET || '';
      const decoded = jwt.verify(token, secret) as { id: string };

      // Confirm the user still exists and is active in the DB
      const user = await CrmUser.findById(decoded.id).select('_id organizationId role isActive');
      if (!user || !user.isActive) return next(new Error('User not found or inactive'));

      // Attach the user to the socket for use in the connection handler below
      (socket as any).crmUser = user;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection handler ────────────────────────────────────────────────────
  // Fires once per authenticated connection.
  io.on('connection', (socket: Socket) => {
    const user = (socket as any).crmUser;

    // Reject connections from users with no organisation (shouldn't happen
    // after the auth middleware above, but guard anyway)
    if (!user?.organizationId) {
      socket.disconnect();
      return;
    }

    // Join the organisation-specific room.
    // All feed events are emitted to this room, not to individual sockets,
    // so every tab/device the user has open receives the update.
    const orgRoom = `org:${user.organizationId.toString()}`;
    socket.join(orgRoom);

    // Clean up when the client disconnects (tab closed, network drop, etc.)
    socket.on('disconnect', () => {
      socket.leave(orgRoom);
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