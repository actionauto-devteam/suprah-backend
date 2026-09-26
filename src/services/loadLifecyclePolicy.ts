/**
 * Pure lifecycle rules shared by the generic Load endpoints and Driver
 * Tracking. Kept free of database imports so the rules can be unit tested and
 * reused in both the pre-check (clear error message) and the conditional
 * write filter (race protection).
 */

// Must match DRIVER_ACTIVE_LOAD_STATUSES in driverReviewAccess.service (a unit
// test enforces this); duplicated here to keep this module database-free.
export const REASSIGNABLE_LOAD_STATUSES = ["Assigned", "Accepted", "Picked Up", "In-Transit"] as const;

type LoadLike = {
  loadNumber?: string | null;
  status?: string | null;
  assignedDriverId?: unknown;
  proofOfDelivery?: {
    imageUrl?: string | null;
    submittedBy?: unknown;
    confirmedAt?: unknown;
  } | null;
};

const hasId = (value: unknown) => String(value ?? "").trim() !== "";
const loadRef = (load: LoadLike) => (load.loadNumber ? `load ${load.loadNumber}` : "this load");

// Unassigned work that was never handed to a driver, plus closed records.
export const UNASSIGNED_DELETABLE_LOAD_STATUSES = ["Draft", "Posted"] as const;
export const CLOSED_DELETABLE_LOAD_STATUSES = ["Cancelled", "Delivered"] as const;

export function canStaffDeleteLoad(load: LoadLike): boolean {
  const status = String(load.status ?? "");
  if ((CLOSED_DELETABLE_LOAD_STATUSES as readonly string[]).includes(status)) return true;
  return (
    (UNASSIGNED_DELETABLE_LOAD_STATUSES as readonly string[]).includes(status) &&
    !hasId(load.assignedDriverId)
  );
}

/** Mongo filter equivalent of canStaffDeleteLoad, for the conditional delete. */
export function staffDeletableLoadFilter() {
  return {
    $or: [
      { status: { $in: [...CLOSED_DELETABLE_LOAD_STATUSES] } },
      {
        status: { $in: [...UNASSIGNED_DELETABLE_LOAD_STATUSES] },
        assignedDriverId: null,
      },
    ],
  };
}

/** Reassign replaces an existing driver; unassigned loads must use Assign. */
export function isReassignableLoad(load: LoadLike): boolean {
  return (
    hasId(load.assignedDriverId) &&
    (REASSIGNABLE_LOAD_STATUSES as readonly string[]).includes(String(load.status ?? ""))
  );
}

/**
 * Proof of delivery counts for a driver only if that driver submitted it.
 * Legacy proof recorded before submittedBy existed is accepted.
 */
export function proofOfDeliveryBelongsTo(load: LoadLike, driverId: string): boolean {
  const submittedBy = load.proofOfDelivery?.submittedBy;
  return !hasId(submittedBy) || String(submittedBy) === String(driverId);
}

/** Mongo filter equivalent of proofOfDeliveryBelongsTo. */
export function proofOfDeliveryOwnedByFilter(driverId: unknown) {
  return {
    $or: [
      { "proofOfDelivery.submittedBy": driverId },
      { "proofOfDelivery.submittedBy": { $exists: false } },
      { "proofOfDelivery.submittedBy": null },
    ],
  };
}

export type DeliveryConfirmationCheck =
  | { ok: true; alreadyConfirmed: boolean }
  | { ok: false; statusCode: number; message: string };

/** Staff confirm proof of delivery only after the driver completed delivery. */
export function checkDeliveryConfirmation(load: LoadLike): DeliveryConfirmationCheck {
  if (!load.proofOfDelivery?.imageUrl) {
    return { ok: false, statusCode: 400, message: `The driver hasn't submitted a proof-of-delivery photo for ${loadRef(load)} yet, so there is nothing to confirm.` };
  }
  if (load.status !== "Delivered") {
    return {
      ok: false,
      statusCode: 409,
      message: `You can't confirm delivery of ${loadRef(load)} yet. The driver must complete delivery in their app first (the load is ${load.status}).`,
    };
  }
  if (hasId(load.assignedDriverId) && !proofOfDeliveryBelongsTo(load, String(load.assignedDriverId))) {
    return {
      ok: false,
      statusCode: 409,
      message: `The proof-of-delivery photo on ${loadRef(load)} was uploaded by a different driver, so it can't be confirmed. Ask the assigned driver to upload their own photo.`,
    };
  }
  return { ok: true, alreadyConfirmed: Boolean(load.proofOfDelivery.confirmedAt) };
}

export type ProofOfDeliverySubmissionCheck =
  | { ok: true }
  | { ok: false; statusCode: number; message: string };

/** Only the assigned driver may submit proof, only while In-Transit and unconfirmed. */
export function checkProofOfDeliverySubmission(
  load: LoadLike,
  driverId: string,
): ProofOfDeliverySubmissionCheck {
  if (!hasId(load.assignedDriverId) || String(load.assignedDriverId) !== String(driverId)) {
    return { ok: false, statusCode: 403, message: `${loadRef(load).replace(/^l/, "L")} is not assigned to you, so you can't submit a proof-of-delivery photo for it.` };
  }
  if (load.status !== "In-Transit") {
    return {
      ok: false,
      statusCode: 409,
      message: `You can't submit a proof-of-delivery photo for ${loadRef(load)} because it is ${load.status}. Photos are submitted when you complete delivery of an In-Transit load.`,
    };
  }
  if (load.proofOfDelivery?.confirmedAt) {
    return {
      ok: false,
      statusCode: 409,
      message: `Dispatch already confirmed the delivery of ${loadRef(load)}, so its proof-of-delivery photo can't be replaced.`,
    };
  }
  return { ok: true };
}
