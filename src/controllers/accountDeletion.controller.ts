import type { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiError } from "../utils/ApiError";
import { ApiResponse } from "../utils/ApiResponse";
import { deleteOwnAccount } from "../services/accountDeletion.service";

/**
 * DELETE /api/driver-profile/account (drivers, also while waiting for approval)
 * DELETE /api/profile/delete-account (customers)
 * Deletes the signed-in person's own account (2026-11-11). See
 * services/accountDeletion.service for what's removed and what's kept.
 * Body: { acknowledgedRetention: true } — they acknowledged what Suprah AI keeps.
 */
const deleteMyAccount = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as { _id?: unknown; role?: unknown; email?: unknown } | undefined;
  if (!user?._id) throw new ApiError(401, "Your session ended. Sign in again to continue.");
  await deleteOwnAccount(
    { _id: String(user._id), role: user.role, email: user.email },
    { acknowledgedRetention: req.body?.acknowledgedRetention },
  );
  res.status(200).json(new ApiResponse(200, null, "Your account was deleted."));
});

export default { deleteMyAccount };
