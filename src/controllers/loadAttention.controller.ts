import { Request, Response } from "express";
import Load from "../models/Load.model";
import User, { IUser } from "../models/User.model";
import DriverLocation from "../models/DriverLocation.model";
import DriverProfile, { COMPLIANCE_EXPIRY_FIELDS } from "../models/DriverProfile.model";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ACTIVE_LOAD_STATUSES } from "../constants/loadStatus";
import { canViewDriverExactGps } from "../services/driverLocationAccess.service";
import { businessDateParts } from "../utils/businessDate";
import {
  buildLoadAttention,
  type AttentionLoad,
  type AttentionLocation,
  type AttentionProfile,
} from "../services/loadAttention.service";

const ATTENTION_LOAD_FIELDS =
  "_id loadNumber status organizationId assignedDriverId dispatchOwnerId dates.pickupDeadline dates.deliveryDeadline proofOfDelivery.submittedAt";

const driverIdsOf = (loads: AttentionLoad[]) => [
  ...new Set(loads.map((load) => String(load.assignedDriverId ?? "").trim()).filter(Boolean)),
];

/**
 * GET /api/loads/attention
 * This organization's loads that need Dispatch now: delivery proofs waiting
 * for confirmation, missed pickup/delivery days, drivers whose GPS has gone
 * quiet (only for the dispatcher in charge and org admins, like the alert),
 * and drivers whose CDL, medical card or insurance has expired or expires soon.
 */
const getLoadAttention = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;
  const user = req.user as IUser;

  const [activeLoads, proofLoads] = (await Promise.all([
    Load.find({
      organizationId,
      status: { $in: ACTIVE_LOAD_STATUSES },
      assignedDriverId: { $ne: null },
    })
      .select(ATTENTION_LOAD_FIELDS)
      .sort({ updatedAt: -1 })
      .limit(1000)
      .lean(),
    // The same rule as the payouts page's pending proofs.
    Load.find({
      organizationId,
      "proofOfDelivery.imageUrl": { $exists: true, $ne: "" },
      "proofOfDelivery.confirmedAt": { $exists: false },
    })
      .select(ATTENTION_LOAD_FIELDS)
      .sort({ "proofOfDelivery.submittedAt": 1 })
      .limit(200)
      .lean(),
  ])) as unknown as [AttentionLoad[], AttentionLoad[]];

  const driverIds = driverIdsOf([...activeLoads, ...proofLoads]);
  const activeDriverIds = driverIdsOf(activeLoads);

  const [drivers, locations, profiles] = await Promise.all([
    driverIds.length ? User.find({ _id: { $in: driverIds } }).select("name").lean() : Promise.resolve([]),
    activeDriverIds.length
      ? DriverLocation.find({ userId: { $in: activeDriverIds } })
          .select("userId status offlineAlertSentAt lastSeenAt locationRecordedAt")
          .lean()
      : Promise.resolve([]),
    activeDriverIds.length
      ? DriverProfile.find({ userId: { $in: activeDriverIds } })
          .select([
            "userId",
            ...COMPLIANCE_EXPIRY_FIELDS,
            "documents.type",
            "documents.label",
            "documents.expiresAt",
            "documents.reviewStatus",
          ])
          .lean()
      : Promise.resolve([]),
  ]);

  const { year, month, day } = businessDateParts();
  const data = buildLoadAttention({
    activeLoads,
    proofLoads,
    locations: locations as unknown as AttentionLocation[],
    profiles: profiles as unknown as AttentionProfile[],
    driverNames: new Map(
      (drivers as Array<{ _id: unknown; name?: string }>).map((driver) => [String(driver._id), driver.name || "Driver"]),
    ),
    canSeeGps: (load) => canViewDriverExactGps(user, [load as Parameters<typeof canViewDriverExactGps>[1][number]]),
    todayKey: `${year}-${month}-${day}`,
  });

  return res.status(200).json(new ApiResponse(200, data, "Loads needing attention fetched"));
});

export default { getLoadAttention };
