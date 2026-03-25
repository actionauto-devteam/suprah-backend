import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import Load from "../models/Load.model";
import { IUser } from "../models/User.model";
import { createLoadSchema } from "../validations/load.validation";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getUser = (req: Request) => req.user as IUser;

// ─── Create Load ──────────────────────────────────────────────────────────────

const createLoad = asyncHandler(async (req: Request, res: Response) => {
  const user = getUser(req);
  const organizationId = req.orgId as string;

  // Validate request body
  const parsed = createLoadSchema.safeParse(req.body);
  if (!parsed.success) {
    const messages = parsed.error.issues.map((i) => i.message).join(", ");
    throw new ApiError(400, messages);
  }

  const { postType, pickupLocation, deliveryLocation } = parsed.data;

  const load = await Load.create({
    organizationId,
    orgId: (user as any).orgId,
    createdBy: user._id,
    postType,
    pickupLocation,
    deliveryLocation,
    status: "Draft",
  });

  return res
    .status(201)
    .json(new ApiResponse(201, load, "Load created successfully"));
});

// ─── Get Loads ────────────────────────────────────────────────────────────────

const getLoads = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;

  const loads = await Load.find({ organizationId })
    .sort({ createdAt: -1 })
    .lean();

  return res
    .status(200)
    .json(new ApiResponse(200, loads, "Loads fetched successfully"));
});

// ─── Get Load by ID ───────────────────────────────────────────────────────────

const getLoadById = asyncHandler(async (req: Request, res: Response) => {
  const organizationId = req.orgId as string;

  const load = await Load.findOne({ _id: req.params.id, organizationId });
  if (!load) {
    throw new ApiError(404, "Load not found");
  }

  return res
    .status(200)
    .json(new ApiResponse(200, load, "Load fetched successfully"));
});

export default { createLoad, getLoads, getLoadById };
