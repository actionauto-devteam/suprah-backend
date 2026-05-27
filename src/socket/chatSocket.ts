import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import logger from "../utils/logger";

/**
 * Real-time layer for the Appointment Dashboard chat.
 *
 * Architecture:
 *  - REST endpoints (chat.controller) are the source of truth + persistence.
 *  - After each successful REST mutation, the controller calls emitChatEvent()
 *    which broadcasts to every socket joined to that organization's room.
 *  - Clients render the broadcast instantly; if the socket is unavailable they
 *    fall back to REST polling (see the frontend useDashboardChat hook).
 *
 * Wiring (in your server bootstrap, e.g. server.ts / index.ts):
 *
 *   import http from "http";
 *   import app from "./app";
 *   import { initChatSocket } from "./socket/chatSocket";
 *
 *   const server = http.createServer(app);
 *   initChatSocket(server, {
 *     // Reuse your existing token verification. Must return { userId, orgId }
 *     // (and optionally name/role) or throw on invalid tokens.
 *     verifyToken: async (token) => myVerifyCrmToken(token),
 *     corsOrigins: [process.env.CLIENT_URL ?? "*"],
 *   });
 *   server.listen(PORT);   // <-- listen on `server`, NOT app.listen()
 */

export interface SocketIdentity {
  userId: string;
  orgId: string;
  name?: string;
  role?: string;
}

interface InitOptions {
  verifyToken: (token: string) => Promise<SocketIdentity> | SocketIdentity;
  corsOrigins?: string[] | string;
}

let io: SocketIOServer | null = null;

function roomFor(orgId: string) {
  return `org:${orgId}`;
}

export function initChatSocket(server: HttpServer, options: InitOptions) {
  io = new SocketIOServer(server, {
    path: "/socket.io",
    cors: {
      origin: options.corsOrigins ?? "*",
      credentials: true,
    },
  });

  // Authenticate every connection from the handshake before it joins a room.
  io.use(async (socket: Socket, next) => {
    try {
      const token =
        (socket.handshake.auth?.token as string) ||
        (socket.handshake.headers?.authorization as string)?.replace(
          /^Bearer\s+/i,
          "",
        );

      if (!token) return next(new Error("Authentication token required"));

      const identity = await options.verifyToken(token);
      if (!identity?.orgId) return next(new Error("Invalid token: no org"));

      (socket.data as SocketIdentity) = identity;
      next();
    } catch (err) {
      logger.warn({ err }, "Socket authentication failed");
      next(new Error("Authentication failed"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const { orgId, userId } = socket.data as SocketIdentity;
    socket.join(roomFor(orgId));
    logger.info({ userId, orgId, socketId: socket.id }, "Chat socket connected");

    // Optional lightweight presence / typing relay (org-scoped).
    socket.on("chat:typing", (payload: { name?: string }) => {
      socket.to(roomFor(orgId)).emit("chat:typing", {
        userId,
        name: payload?.name,
      });
    });

    socket.on("disconnect", () => {
      logger.info({ userId, orgId, socketId: socket.id }, "Chat socket disconnected");
    });
  });

  logger.info("Chat Socket.IO server initialized");
  return io;
}

/**
 * Broadcast a chat event to an organization room.
 * Safe to call even if sockets were never initialized (REST still works).
 */
export function emitChatEvent(
  orgId: string,
  event: "chat:new" | "chat:update" | "chat:delete",
  payload: unknown,
) {
  if (!io) return;
  io.to(roomFor(orgId)).emit(event, payload);
}

export function getIO() {
  return io;
}