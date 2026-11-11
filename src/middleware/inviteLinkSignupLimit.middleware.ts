import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { ApiError } from "../utils/ApiError";
import { SUPPORT_EMAIL } from "../utils/userMessages";

/**
 * A limit on accounts created with invite links from one connection
 * (2026-11-11). The sign-in limit counts per email address, so on its own it
 * doesn't stop one computer creating many accounts with different emails.
 * A family or a dealership's showroom Wi-Fi signing up together stays well
 * under this.
 */
export const inviteLinkSignupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  skip: () => process.env.SKIP_RATE_LIMIT === "true",
  keyGenerator: (req: any) => `invite-link-signup:${ipKeyGenerator(req.ip ?? "unknown")}`,
  message: {
    success: false,
    message: `A lot of accounts were created from this connection in the last hour. Wait a while, then try again. If this keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`,
  },
  handler: (req, res, next, options) => {
    next(new ApiError(429, options.message.message));
  },
  standardHeaders: true,
  legacyHeaders: false,
});
