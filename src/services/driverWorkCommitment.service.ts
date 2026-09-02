import { randomUUID } from "crypto";
import mongoose from "mongoose";
import Load from "../models/Load.model";
import DriverProfile from "../models/DriverProfile.model";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";

export const DRIVER_COMMITMENT_LOAD_STATUSES = [
  "Assigned",
  "Accepted",
  "Picked Up",
  "In-Transit",
] as const;

const DRIVER_COMMITMENT_LOCK_MS = 30_000;

export type DriverCommitmentConflict = {
  status: string;
  pickupDate: string | null;
  deliveryDate: string | null;
  reason: "overlapping_schedule" | "active_trip" | "schedule_unknown";
};

/**
 * Load schedule values are date-only Transportation business-calendar fields.
 * Extract their canonical YYYY-MM-DD value rather than deriving a day from the
 * server's timezone or the UTC-midnight Mongo storage anchor.
 */
function scheduleDateKey(value: unknown): string | null {
  if (!value) return null;

  const raw =
    value instanceof Date
      ? value.toISOString()
      : String(value).trim();

  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function scheduleDateOrdinal(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  // UTC is used only as a timezone-neutral sortable number for YYYY-MM-DD.
  // It does not define the business timezone or a scheduling day boundary.
  return Date.UTC(year, month - 1, day);
}

export function getDriverLoadCommitmentWindow(load: any) {
  const pickupDate =
    scheduleDateKey(load?.dates?.firstAvailable) ??
    scheduleDateKey(load?.dates?.pickupDeadline) ??
    scheduleDateKey(load?.requestedPickupDate);
  const pickupDeadline =
    scheduleDateKey(load?.dates?.pickupDeadline);
  const deliveryDate =
    scheduleDateKey(load?.dates?.deliveryDeadline) ??
    pickupDeadline ??
    pickupDate;

  if (!pickupDate || !deliveryDate) {
    return {
      start: null as number | null,
      end: null as number | null,
      pickupDate,
      deliveryDate,
    };
  }

  const pickupOrdinal = scheduleDateOrdinal(pickupDate);
  const deliveryOrdinal = scheduleDateOrdinal(deliveryDate);
  return {
    start: Math.min(pickupOrdinal, deliveryOrdinal),
    end: Math.max(pickupOrdinal, deliveryOrdinal),
    pickupDate,
    deliveryDate,
  };
}

function windowsOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number },
) {
  return a.start <= b.end && b.start <= a.end;
}

export async function findDriverCommitmentConflicts(params: {
  driverId: string;
  targetLoad: any;
  excludeLoadId?: string;
}) {
  const { driverId, targetLoad, excludeLoadId } = params;
  const targetWindow = getDriverLoadCommitmentWindow(targetLoad);

  const filter: Record<string, any> = {
    assignedDriverId: driverId,
    status: { $in: DRIVER_COMMITMENT_LOAD_STATUSES },
  };
  if (excludeLoadId && mongoose.Types.ObjectId.isValid(excludeLoadId)) {
    filter._id = { $ne: new mongoose.Types.ObjectId(excludeLoadId) };
  }

  // Platform-wide on purpose: organizationId must never appear in this query.
  const commitments: any[] = await Load.find(filter)
    .select("_id status dates requestedPickupDate")
    .lean();

  const conflicts: DriverCommitmentConflict[] = [];
  for (const existing of commitments) {
    const existingWindow = getDriverLoadCommitmentWindow(existing);

    // Picked Up / In-Transit means the driver is physically executing a trip.
    // Do not create a second operational commitment even if legacy dates are
    // missing or appear non-overlapping.
    if (["Picked Up", "In-Transit"].includes(String(existing.status))) {
      conflicts.push({
        status: String(existing.status),
        pickupDate: existingWindow.pickupDate,
        deliveryDate: existingWindow.deliveryDate,
        reason: "active_trip",
      });
      continue;
    }

    // Date-less Assigned/Accepted work cannot be proved non-overlapping.
    // Fail closed rather than silently double-book a shared driver.
    if (
      !targetWindow.start ||
      !targetWindow.end ||
      !existingWindow.start ||
      !existingWindow.end
    ) {
      conflicts.push({
        status: String(existing.status),
        pickupDate: existingWindow.pickupDate,
        deliveryDate: existingWindow.deliveryDate,
        reason: "schedule_unknown",
      });
      continue;
    }

    if (
      windowsOverlap(
        { start: targetWindow.start, end: targetWindow.end },
        { start: existingWindow.start, end: existingWindow.end },
      )
    ) {
      conflicts.push({
        status: String(existing.status),
        pickupDate: existingWindow.pickupDate,
        deliveryDate: existingWindow.deliveryDate,
        reason: "overlapping_schedule",
      });
    }
  }

  return conflicts;
}

export async function assertNoDriverCommitmentConflict(params: {
  driverId: string;
  targetLoad: any;
  excludeLoadId?: string;
  actor: "driver" | "dispatcher";
}) {
  const conflicts = await findDriverCommitmentConflicts(params);
  if (!conflicts.length) return;

  // Deliberately do not return organization IDs, other Load IDs, customers,
  // routes or dispatcher identities. Cross-org commitment existence is enough
  // to enforce integrity; the caller is not entitled to the other org's data.
  throw new ApiError(
    409,
    params.actor === "driver"
      ? "You already have another active Load commitment that conflicts with this schedule. Complete or resolve that work with Dispatch before taking this Load."
      : "This driver already has another active Load commitment that conflicts with this schedule. Choose another driver or resolve the existing commitment first.",
    [
      {
        type: "driver_global_commitment_conflict",
        conflictCount: conflicts.length,
        conflicts: conflicts.map((conflict) => ({
          status: conflict.status,
          pickupDate: conflict.pickupDate,
          deliveryDate: conflict.deliveryDate,
          reason: conflict.reason,
        })),
      },
    ],
  );
}

async function acquireDriverCommitmentLock(driverId: string) {
  if (!mongoose.Types.ObjectId.isValid(driverId)) {
    throw new ApiError(400, "Invalid driver identifier");
  }

  const token = randomUUID();
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + DRIVER_COMMITMENT_LOCK_MS);

  try {
    const profile = await DriverProfile.findOneAndUpdate(
      {
        userId: driverId,
        $or: [
          { "commitmentLock.lockedUntil": { $exists: false } },
          { "commitmentLock.lockedUntil": null },
          { "commitmentLock.lockedUntil": { $lte: now } },
        ],
      },
      {
        $set: {
          commitmentLock: {
            token,
            acquiredAt: now,
            lockedUntil,
          },
        },
        $setOnInsert: { userId: driverId },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    if (!profile) {
      throw new ApiError(
        409,
        "This driver's assignment state is being updated by another Dispatch action. Try again in a moment.",
      );
    }
    return token;
  } catch (error: any) {
    // When a profile already exists but is currently locked, the upsert path
    // may hit the unique userId index. Treat that as lock contention, not 500.
    if (Number(error?.code) === 11000 || error instanceof ApiError) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        409,
        "This driver's assignment state is being updated by another Dispatch action. Try again in a moment.",
      );
    }
    throw error;
  }
}

async function releaseDriverCommitmentLock(driverId: string, token: string) {
  try {
    await DriverProfile.updateOne(
      { userId: driverId, "commitmentLock.token": token },
      { $unset: { commitmentLock: "" } },
    );
  } catch (error) {
    logger.error(
      { error, driverId },
      "Non-fatal: failed to release shared-driver commitment lock",
    );
  }
}

export async function withDriverCommitmentLock<T>(
  driverId: string,
  work: () => Promise<T>,
): Promise<T> {
  const token = await acquireDriverCommitmentLock(driverId);
  try {
    return await work();
  } finally {
    await releaseDriverCommitmentLock(driverId, token);
  }
}