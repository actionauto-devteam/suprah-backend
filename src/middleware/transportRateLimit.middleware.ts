import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { ApiError } from "../utils/ApiError";
import { SUPPORT_EMAIL } from "../utils/userMessages";

/**
 * Limits for Driver Tracker, Driver Portal, Dispatch Chat and Transportation
 * actions that notify other people or store files. Each one only stops
 * runaway repeats (a stuck retry, a script, repeated taps); normal use never
 * reaches it. Driver heartbeats and location updates are deliberately not
 * limited here, because a limit there would break live tracking.
 *
 * Counts are per signed-in person. One limiter used on several routes shares
 * one count, so direct Dispatch Chat and channels draw from the same allowance.
 */

const CONTACT_SUPPORT = `If this keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`;

function perPersonLimiter(windowMs: number, max: number, message: string) {
  return rateLimit({
    windowMs,
    max,
    skip: () => process.env.SKIP_RATE_LIMIT === "true",
    keyGenerator: (req: any) => req.user?._id?.toString() ?? ipKeyGenerator(req.ip ?? "unknown"),
    message: { success: false, message: `${message} ${CONTACT_SUPPORT}` },
    handler: (req, res, next, options) => {
      next(new ApiError(429, options.message.message));
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
}

// Each upload can carry 5 files of up to 25 MB.
export const dispatchChatUploadLimiter = perPersonLimiter(
  10 * 60 * 1000,
  30,
  "You've sent a lot of files in the last few minutes. Wait a few minutes, then send the rest.",
);

// Every message notifies the other people in the conversation.
export const dispatchChatMessageLimiter = perPersonLimiter(
  60 * 1000,
  30,
  "You're sending messages very quickly. Wait a minute, then send your message again.",
);

// Requesting, cancelling, releasing and dropping a load each notify the
// dispatcher and the organization's admins, so one allowance covers them all.
export const driverLoadRequestLimiter = perPersonLimiter(
  10 * 60 * 1000,
  20,
  "You've requested, cancelled or released loads many times in the last few minutes. Wait a few minutes, then try again.",
);

// Creating a quote notifies the organization's admins; converting one creates a load.
export const quoteChangeLimiter = perPersonLimiter(
  10 * 60 * 1000,
  60,
  "You've created or changed a lot of quotes in the last few minutes. Wait a few minutes, then try again.",
);
