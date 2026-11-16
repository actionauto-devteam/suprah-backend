import mongoose from "mongoose";
import User from "../models/User.model";
import { ApiError } from "./ApiError";

/**
 * Who an inventory car is assigned to (2026-11-16): an active staff member of
 * the car's own dealership, or nobody. Any other account is refused, so a car
 * can't be pointed at someone else's account.
 */
export const VEHICLE_ASSIGNEE_NOT_STAFF =
  "You can only assign this car to an active staff member of your dealership.";

const STAFF_ROLES = ["super_admin", "admin", "employee"];

export type VehicleAssignee =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; id: mongoose.Types.ObjectId };

const idOf = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (value instanceof mongoose.Types.ObjectId) return value.toString();
  if (value && typeof value === "object" && "_id" in value) return idOf((value as { _id: unknown })._id);
  return "";
};

/** Reads `assignedTo` from a car's create or edit request. */
export async function resolveVehicleAssignee(
  body: unknown,
  organizationId: string,
): Promise<VehicleAssignee> {
  if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "assignedTo")) {
    return { kind: "unchanged" };
  }
  const raw = (body as { assignedTo?: unknown }).assignedTo;
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return { kind: "clear" };
  }

  const id = idOf(raw);
  if (!/^[0-9a-fA-F]{24}$/.test(id) || !organizationId) {
    throw new ApiError(400, VEHICLE_ASSIGNEE_NOT_STAFF);
  }
  const staff = await User.exists({
    _id: id,
    organizationId,
    role: { $in: STAFF_ROLES },
    isActive: { $ne: false },
  });
  if (!staff) throw new ApiError(400, VEHICLE_ASSIGNEE_NOT_STAFF);
  return { kind: "set", id: new mongoose.Types.ObjectId(id) };
}

/**
 * The assigned staff member as the inventory list returns them: id, name and
 * email only. The account's other fields never leave the database query.
 */
export const ASSIGNED_STAFF_SUMMARY_STAGE = {
  $addFields: {
    assignedTo: {
      $cond: [
        { $ifNull: ["$assignedTo._id", false] },
        { _id: "$assignedTo._id", name: "$assignedTo.name", email: "$assignedTo.email" },
        "$$REMOVE",
      ],
    },
  },
};
