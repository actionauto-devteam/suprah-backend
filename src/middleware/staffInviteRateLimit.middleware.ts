import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { ApiError } from "../utils/ApiError";
import { SUPPORT_EMAIL } from "../utils/userMessages";

/**
 * Limits on sending staff invitations (2026-11-11). Every invitation is an
 * email sent from Suprah AI, so a signed-in admin (or someone using a stolen
 * admin sign-in) can't use it to send floods of email. Normal use, including
 * inviting a whole team with Bulk Invite, never reaches these. Counts are per
 * signed-in person.
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

// One invitation (or one resend) per request.
export const staffInviteSendLimiter = perPersonLimiter(
  60 * 60 * 1000,
  30,
  "You've sent a lot of invitations in the last hour. Wait a while, then send the rest.",
);

// Each Bulk Invite can carry up to 50 emails.
export const staffBulkInviteLimiter = perPersonLimiter(
  60 * 60 * 1000,
  5,
  "You've used Bulk Invite several times in the last hour. Wait a while, then send the rest.",
);
