import { Model } from "mongoose";
import { ApiError } from "../utils/ApiError";

const DEFAULT_TTL_MINUTES = 15;

interface Claimable {
  claimedBy?: any;
  claimedAt?: Date;
  claimExpiresAt?: Date;
}

// Claim/ownership is a property of the review item itself (who currently has
// it open), not a separate business object — so this operates directly on
// whichever of the three existing review-item models (DriverRequest,
// DriverProfile, DriverStatusChangeRequest) is passed in, rather than
// tracking claims in a parallel collection that could drift out of sync.
export async function claimItem<T extends Claimable>(
  model: Model<T>,
  id: string,
  actorUserId: string,
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): Promise<T> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

  // Optimistic guard: succeeds only if unclaimed, the existing claim has gone
  // stale past its TTL (tab closed without releasing), or the requester
  // already holds it (idempotent re-claim / TTL refresh). Two admins racing
  // to claim the same item cannot both win this update.
  const claimed = await model.findOneAndUpdate(
    {
      _id: id,
      $or: [
        { claimedBy: { $exists: false } },
        { claimedBy: null },
        { claimExpiresAt: { $lt: now } },
        { claimedBy: actorUserId },
      ],
    } as any,
    {
      $set: {
        claimedBy: actorUserId,
        claimedAt: now,
        claimExpiresAt: expiresAt,
      },
    } as any,
    { new: true },
  );

  if (!claimed) {
    const existing: any = await model
      .findById(id)
      .select("claimedBy")
      .populate("claimedBy", "name")
      .lean();
    if (!existing) throw new ApiError(404, "Review item not found");
    throw new ApiError(409, "This item is already claimed by another reviewer.", [
      { claimedByName: existing.claimedBy?.name || "another reviewer" },
    ]);
  }

  return claimed;
}

export async function releaseItem<T extends Claimable>(
  model: Model<T>,
  id: string,
  actorUserId: string,
): Promise<T> {
  const released = await model.findOneAndUpdate(
    { _id: id, claimedBy: actorUserId } as any,
    { $set: { claimedBy: null, claimedAt: null, claimExpiresAt: null } } as any,
    { new: true },
  );

  if (!released) {
    const existing: any = await model.findById(id).select("claimedBy").lean();
    if (!existing) throw new ApiError(404, "Review item not found");
    throw new ApiError(409, "You do not currently hold the claim on this item.");
  }

  return released;
}
