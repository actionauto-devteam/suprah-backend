import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { ApiError } from "../utils/ApiError";
import { SUPPORT_EMAIL } from "../utils/userMessages";

/**
 * Driver document uploads and replacements, on the Documents page and in the
 * application (2026-11-09). A driver adding or renewing several documents in
 * one sitting (the front and back of a card, a few renewals, a retake) isn't
 * stopped after five any more: approved drivers get 20 per 10 minutes, and
 * drivers still finishing their application aren't limited, as before. The
 * message says what to do, since the Documents page uploads one file at a time.
 */
export const DRIVER_DOCUMENT_UPLOADS_PER_WINDOW = 20;

export const DRIVER_DOCUMENT_UPLOAD_LIMIT_MESSAGE =
  `You've uploaded a lot of documents in the last few minutes. Wait 10 minutes, then upload the rest. If this keeps happening, contact Suprah AI support at ${SUPPORT_EMAIL}.`;

export const driverDocumentUploadLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: DRIVER_DOCUMENT_UPLOADS_PER_WINDOW,
  skip: (req: any) =>
    process.env.SKIP_RATE_LIMIT === "true" ||
    (req.user?.role === "driver" && req.user?.isApproved === false),
  keyGenerator: (req: any) => req.user?._id?.toString() ?? ipKeyGenerator(req.ip ?? "unknown"),
  message: { success: false, message: DRIVER_DOCUMENT_UPLOAD_LIMIT_MESSAGE },
  handler: (req, res, next, options) => {
    next(new ApiError(429, options.message.message));
  },
  standardHeaders: true,
  legacyHeaders: false,
});
