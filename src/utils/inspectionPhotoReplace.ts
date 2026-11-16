/**
 * Replacing a car's inspection photo on a load (2026-11-16): the new photo is
 * stored first, then saved for that one car only if it is still the same car
 * in the same place with the same photo, and only then is the old photo
 * deleted. A failed upload never leaves the load pointing at a deleted photo,
 * and two uploads at the same moment can't leave a photo nobody can see.
 */
export const INSPECTION_PHOTO_CHANGED =
  "This car's photo or place on the load changed while you were uploading, so your photo wasn't saved. Refresh the load and try again.";

export function inspectionPhotoFilter(
  loadId: unknown,
  organizationId: string,
  index: number,
  vehicle: { vin?: unknown; inspectionPhotoUrl?: unknown },
): Record<string, unknown> {
  const vin = typeof vehicle?.vin === "string" ? vehicle.vin.trim() : "";
  const photo = typeof vehicle?.inspectionPhotoUrl === "string" ? vehicle.inspectionPhotoUrl : "";
  return {
    _id: loadId,
    organizationId,
    [`vehicles.${index}`]: { $exists: true },
    ...(vin ? { [`vehicles.${index}.vin`]: vin } : {}),
    [`vehicles.${index}.inspectionPhotoUrl`]: photo ? photo : { $in: ["", null] },
  };
}
