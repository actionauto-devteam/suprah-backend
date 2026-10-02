import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import driverTrackingDeviceController from "../controllers/driverTrackingDevice.controller";
import { getTraccarConfig } from "../config/traccar";

// Server-to-server integrations. These are not user sessions: each endpoint
// authenticates its caller itself (Traccar: a shared secret, compared in
// constant time). Off unless configured (config/traccar.ts).
const router = express.Router();

// Refused attempts (an address that isn't allowed, or a wrong secret): 20 per
// address in 15 minutes, then that address is refused for the rest of the
// window. Accepted forwards don't count toward this.
const traccarRejectedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skip: () => process.env.SKIP_RATE_LIMIT === "true",
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401 && res.statusCode !== 403,
  standardHeaders: true,
  legacyHeaders: false,
  message: { accepted: false, reason: "too_many_refused_attempts" },
});

// The whole fleet's positions per minute (TRACCAR_FORWARD_MAX_PER_MINUTE).
const traccarForwardLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: () => getTraccarConfig().forwardMaxPerMinute,
  standardHeaders: true,
  legacyHeaders: false,
  message: { accepted: false, reason: "too_many_requests" },
});

router.post(
  "/traccar/positions",
  traccarRejectedLimiter,
  traccarForwardLimiter,
  driverTrackingDeviceController.receiveTraccarPosition,
);

export default router;
