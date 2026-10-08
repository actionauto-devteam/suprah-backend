import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import trackingAppController, { requireTrackingAppDevice } from "../controllers/trackingApp.controller";

// The Suprah Driver Tracker app. No website sign-in: pairing uses a one-time
// code, and every other request is signed with the phone's own device key
// (see trackingApp.controller.ts). Off unless TRACKING_APP_ENABLED=true.
const router = express.Router();

router.use((_req, res, next) => {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  next();
});

// Wrong pairing codes: 10 per address in 15 minutes, then that address waits
// out the window. Successful pairings don't count.
const pairingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skip: () => process.env.SKIP_RATE_LIMIT === "true",
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    code: 429,
    reason: "too_many_attempts",
    message: "Too many pairing attempts. Wait 15 minutes, then try again with a new code.",
  },
});

router.post("/pair", pairingLimiter, trackingAppController.pair);
router.get("/status", requireTrackingAppDevice, trackingAppController.status);
router.post("/positions", requireTrackingAppDevice, trackingAppController.positions);
router.delete("/device", requireTrackingAppDevice, trackingAppController.unlink);

export default router;
