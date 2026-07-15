import dns from "node:dns";

dns.setServers(["8.8.8.8", "1.1.1.1"]);
dns.setDefaultResultOrder("ipv4first");
import express, { Application } from "express";
import mongoose from "mongoose";
import { createServer } from "http";
import path from "path";
import { Server } from "socket.io";
import { setupSocket } from "./socket";
import { setSocketIO } from "./utils/socketEmitter";
import cors from "cors";
import helmet from "helmet";
import mongoSanitize from "express-mongo-sanitize";
import cookieParser from "cookie-parser";
import connectDB from "./config/db";
import routes from "./routes";
import { errorHandler } from "./middleware/error.middleware";
import passport from "./config/passport";
import config from "./config";
import { initSyncScheduler } from "./schedulers/sync.scheduler";
import { initCleanupScheduler } from "./schedulers/cleanup.scheduler";
import { initMilestoneScheduler } from "./schedulers/milestone.scheduler";
import { initScreenshotRetentionScheduler } from "./schedulers/screenshotRetention.scheduler";
import { initLeadInactivityReminderScheduler } from "./schedulers/leadInactivityReminder.scheduler";
import { initSupraSpaceScheduledMessageScheduler } from "./schedulers/supraspaceScheduledMessage.scheduler";
import { initStaleShiftAutoClockoutScheduler } from "./schedulers/staleShiftAutoClockout.scheduler";
import healthRoute from "./routes/health.route";
import supraSpaceRoute from "./routes/supraspace.route";
import { initSupraSpaceSocket } from "./socket/supraspace.socket";

import { globalLimiter } from "./middleware/rate-limit.middleware";
import { httpLogger } from "./utils/logger";
import logger from "./utils/logger";
import { correlationIdMiddleware } from "./middleware/correlationId.middleware";
import { metricsMiddleware } from "./middleware/metrics.middleware";
import { activityAuditMiddleware } from "./middleware/activityAudit.middleware";
import "./jobs/push.worker";

const app: Application = express();

app.set("trust proxy", 1);

app.use(globalLimiter);

app.use(correlationIdMiddleware);

app.use(metricsMiddleware);

app.use(httpLogger);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: config.env === "production" ? undefined : false,
  }),
);
const httpServer = createServer(app);

// Kick off the DB connection early (during middleware setup) so it's ready
// as soon as possible. We intentionally do NOT block here — schedulers and
// the HTTP listener wait on `waitForDbConnection()` in the bootstrap below.
connectDB();

/**
 * Resolves once Mongoose has an open connection.
 * Prevents startup queries (e.g. the LeadReminder check) from being issued
 * against a not-yet-connected DB, which otherwise buffer and hit
 * `bufferTimeoutMS`, throwing "Operation `leads.find()` buffering timed out".
 */
const waitForDbConnection = (): Promise<void> => {
  if (mongoose.connection.readyState === 1) return Promise.resolve();

  return new Promise((resolve, reject) => {
    mongoose.connection.once("open", () => resolve());
    mongoose.connection.once("error", (err) => reject(err));
  });
};

app.use(
  express.json({
    limit: "512kb",
    verify: (req: any, res, buf) => {
      req.rawBody = buf.toString();
    },
  }),
);

app.use(express.urlencoded({ extended: true, limit: "512kb" }));

app.use(
  express.text({ type: ["application/xml", "text/xml"], limit: "512kb" }),
);

app.use(mongoSanitize());


const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    const allowedOrigins = config.corsOrigin
      .split(",")
      .map((o: string) => o.trim());

    if (!origin) {
      logger.debug("CORS allowed: No Origin");
      return callback(null, true);
    }

    if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
      return callback(null, true);
    }

    if (config.env === "development") {
      logger.debug("CORS allowed (Dev Mode): %s", origin);
      return callback(null, true);
    }

    logger.warn("CORS blocked: %s", origin);
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  },

  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
    "x-impersonate-org-id",
  ],
  exposedHeaders: ["Content-Range", "X-Content-Range"],
  maxAge: 86400,
};

app.use(cors(corsOptions));

// ========================================
// Socket.IO
// ========================================
const io = new Server(httpServer, {
  cors: corsOptions,
});

setupSocket(io);
setSocketIO(io);
initSupraSpaceSocket(httpServer); // Initialize the specialized SupraSpace socket server

logger.info("✓ CORS configured with origins: %s", config.corsOrigin);
logger.info("✓ Environment: %s", config.env);

app.use(cookieParser());
app.use(passport.initialize());

// ========================================
// Health Checks (Liveness & Readiness)
// ========================================
app.use(healthRoute);

// ========================================
// API Routes
// ========================================
app.use(activityAuditMiddleware);
app.use("/api", routes);
app.use("/supraspace", supraSpaceRoute); // Aliased for client-side legacy compatibility

// ========================================
// Global Error Handler
// ========================================
app.use(errorHandler);

// ========================================
// Server Start
// ========================================
if (require.main === module) {
  const startServer = async () => {
    // Wait for the DB to be connected BEFORE starting any scheduler.
    // Several schedulers run an immediate startup query; issuing those before
    // the connection is open is what caused the buffering timeout.
    try {
      await waitForDbConnection();
      logger.info("✓ Database connected. Starting schedulers...");
    } catch (err) {
      logger.fatal({ err }, "Failed to establish DB connection on startup");
      process.exit(1);
      return;
    }

    initSyncScheduler();
    initCleanupScheduler();
    initMilestoneScheduler();
    initScreenshotRetentionScheduler();
    initLeadInactivityReminderScheduler();
    initSupraSpaceScheduledMessageScheduler();
    initStaleShiftAutoClockoutScheduler();

    const server = httpServer.listen(config.port, () => {
      logger.info(`Server running on port ${config.port}`);
    });

    // ─── Graceful Shutdown ────────────────────────────────────────────────────
    const shutdown = async (signal: string) => {
      logger.info(`[${signal}] Received. Starting graceful shutdown...`);

      // 1. Stop accepting new requests
      server.close(() => {
        logger.info("HTTP server closed.");
      });

      // 2. Disconnect from DB and Cache
      try {
        const { disconnectDB } = require("./config/db");
        const { cacheService } = require("./services/cache.service");
        const { pushWorker } = require("./jobs/push.worker");

        await Promise.all([
          disconnectDB(),
          cacheService.disconnect(),
          pushWorker ? pushWorker.close() : Promise.resolve(),
        ]);

        logger.info("Graceful shutdown completed. Exiting process.");
        process.exit(0);
      } catch (err) {
        logger.error({ err }, "Error during graceful shutdown");
        process.exit(1);
      }
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));

    // ─── Global Error Handlers ────────────────────────────────────────────────
    process.on("unhandledRejection", (reason, promise) => {
      logger.error({ reason, promise }, "Unhandled Rejection at Promise");
      // In production, we might want to exit and let Docker restart the container
      if (config.env === "production") {
        shutdown("UNHANDLED_REJECTION");
      }
    });

    process.on("uncaughtException", (err) => {
      logger.fatal({ err }, "Uncaught Exception thrown");
      shutdown("UNCAUGHT_EXCEPTION");
    });
  };

  startServer();
}

export default app;