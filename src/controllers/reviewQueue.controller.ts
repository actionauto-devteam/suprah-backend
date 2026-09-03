import { Request, Response } from "express";
import { Model } from "mongoose";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { IUser } from "../models/User.model";
import DriverRequest from "../models/DriverRequest.model";
import DriverProfile from "../models/DriverProfile.model";
import DriverStatusChangeRequest from "../models/DriverStatusChangeRequest.model";
import { claimItem, releaseItem } from "../services/reviewClaim.service";
import { emitReviewQueueChange } from "../utils/socketEmitter";

const ENTITY_TYPES = [
  "driver-request",
  "driver-profile",
  "driver-status-request",
] as const;
type EntityType = (typeof ENTITY_TYPES)[number];

function modelForEntityType(entityType: string): Model<any> {
  switch (entityType as EntityType) {
    case "driver-request":
      return DriverRequest;
    case "driver-profile":
      return DriverProfile;
    case "driver-status-request":
      return DriverStatusChangeRequest;
    default:
      throw new ApiError(400, `Unknown review queue entity type: ${entityType}`);
  }
}

// Read-side aggregation only — merges the three existing, independently
// maintained status machines into one queue view without introducing a
// fourth collection that would need to be kept in sync with all of them.
const getReviewQueue = asyncHandler(async (req: Request, res: Response) => {
  const [driverRequests, driverProfiles, statusRequests] = await Promise.all([
    DriverRequest.find({ status: "pending" })
      .populate("driverUserId", "name email avatar")
      .populate("claimedBy", "name")
      .lean(),
    DriverProfile.find({
      $or: [
        { verificationStatus: { $in: ["pending", "in_progress", "under_review"] } },
        { "documents.reviewStatus": "pending" },
      ],
    })
      .populate("userId", "name email avatar")
      .populate("claimedBy", "name")
      .lean(),
    DriverStatusChangeRequest.find({ status: "pending" })
      .populate("driverId", "name email avatar")
      .populate("claimedBy", "name")
      .lean(),
  ]);

  const items = [
    ...driverRequests.map((request: any) => ({
      id: String(request._id),
      entityType: "driver-request" as const,
      driverId: request.driverUserId?._id ? String(request.driverUserId._id) : String(request.driverUserId),
      driverName: request.driverUserId?.name ?? "Unknown driver",
      submittedAt: request.createdAt,
      claimedBy: request.claimedBy ? { id: String(request.claimedBy._id), name: request.claimedBy.name } : null,
      claimedAt: request.claimedAt ?? null,
      priority: "standard" as const,
      summary: "New driver application awaiting review",
    })),
    ...driverProfiles.map((profile: any) => {
      const pendingDocs = (Array.isArray(profile.documents) ? profile.documents : []).filter(
        (doc: any) => doc.reviewStatus === "pending",
      ).length;
      return {
        id: String(profile._id),
        entityType: "driver-profile" as const,
        driverId: profile.userId?._id ? String(profile.userId._id) : String(profile.userId),
        driverName: profile.userId?.name ?? "Unknown driver",
        submittedAt: profile.updatedAt ?? profile.createdAt,
        claimedBy: profile.claimedBy ? { id: String(profile.claimedBy._id), name: profile.claimedBy.name } : null,
        claimedAt: profile.claimedAt ?? null,
        priority: "standard" as const,
        summary:
          pendingDocs > 0
            ? `${pendingDocs} document${pendingDocs === 1 ? "" : "s"} awaiting review`
            : "Driver verification awaiting review",
      };
    }),
    ...statusRequests.map((request: any) => ({
      id: String(request._id),
      entityType: "driver-status-request" as const,
      driverId: request.driverId?._id ? String(request.driverId._id) : String(request.driverId),
      driverName: request.driverId?.name ?? "Unknown driver",
      submittedAt: request.submittedAt ?? request.createdAt,
      claimedBy: request.claimedBy ? { id: String(request.claimedBy._id), name: request.claimedBy.name } : null,
      claimedAt: request.claimedAt ?? null,
      priority: request.priority ?? "standard",
      summary: `Work availability change requested: ${request.requestedStatus}`,
    })),
  ].sort(
    (a, b) => new Date(a.submittedAt ?? 0).getTime() - new Date(b.submittedAt ?? 0).getTime(),
  );

  res.json(new ApiResponse(200, { items, total: items.length }, "Review queue fetched"));
});

const claimReviewItem = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { entityType, id } = req.params;
  const model = modelForEntityType(entityType);

  const claimed = await claimItem(model, id, user._id.toString());

  emitReviewQueueChange({
    entityType,
    id,
    claimedBy: { id: user._id.toString(), name: user.name },
    claimedAt: (claimed as any).claimedAt,
  });

  res.json(new ApiResponse(200, claimed, "Item claimed"));
});

const releaseReviewItem = asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as IUser;
  const { entityType, id } = req.params;
  const model = modelForEntityType(entityType);

  const released = await releaseItem(model, id, user._id.toString());

  emitReviewQueueChange({ entityType, id, claimedBy: null, claimedAt: null });

  res.json(new ApiResponse(200, released, "Item released"));
});

export default {
  getReviewQueue,
  claimReviewItem,
  releaseReviewItem,
};
