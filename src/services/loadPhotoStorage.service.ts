import Load from "../models/Load.model";
import config from "../config";
import { storageService, BucketType } from "./storage.service";
import logger from "../utils/logger";

/*
 * Load photos live in the private bucket and are stored on the load as storage
 * keys ("load-inspection/abc.jpg"); screens get short-lived signed links made
 * from those keys. These helpers keep the stored keys correct and clean them
 * up when a load is deleted.
 */

/** A stored storage key, as opposed to a link (signed URL, data URL). */
export function isStoredPhotoKey(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !/^(https?:|data:|blob:)/i.test(value.trim());
}

/**
 * The storage key inside a signed link to the private bucket, or null for any
 * other link. Path-style links are /<bucket>/<key>, virtual-host ones /<key>.
 */
export function keyFromSignedPhotoUrl(value: unknown, privateBucket: string | undefined = config.r2?.buckets?.private): string | null {
  if (typeof value !== "string" || !/^https?:/i.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  // Only links we signed (S3/R2 query-string signatures), never other images.
  if (!url.searchParams.has("X-Amz-Signature")) return null;
  let path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (privateBucket && path.startsWith(`${privateBucket}/`)) path = path.slice(privateBucket.length + 1);
  return path || null;
}

/**
 * The edit form gets signed links for inspection photos and sends them back
 * when the load is saved. Storing a link (it expires in an hour) would break
 * the photo, so each one is turned back into its storage key.
 */
export function restoreInspectionPhotoKeys<T extends { inspectionPhotoUrl?: unknown }>(
  incoming: T[],
  existing: Array<{ inspectionPhotoUrl?: unknown }> = [],
): T[] {
  const knownKeys = existing.map((vehicle) => vehicle?.inspectionPhotoUrl).filter(isStoredPhotoKey);
  return incoming.map((vehicle) => {
    const value = vehicle?.inspectionPhotoUrl;
    if (typeof value !== "string" || !/^https?:/i.test(value)) return vehicle;
    const derived = keyFromSignedPhotoUrl(value);
    if (!derived) return vehicle;
    const key = knownKeys.find((known) => known === derived) ?? derived;
    return { ...vehicle, inspectionPhotoUrl: key };
  });
}

/** Every stored photo key on a load: inspection, pickup, delivery, condition photos, earlier drivers' proofs. */
export function collectLoadPhotoKeys(load: Record<string, any> | null | undefined): string[] {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    if (isStoredPhotoKey(value)) keys.add(value.trim());
  };
  add(load?.proofOfPickup?.imageUrl);
  add(load?.proofOfDelivery?.imageUrl);
  for (const vehicle of load?.vehicles ?? []) add(vehicle?.inspectionPhotoUrl);
  for (const report of load?.conditionReports ?? []) for (const photo of report?.photos ?? []) add(photo?.key);
  for (const entry of load?.assignmentHistory ?? []) {
    add(entry?.proofOfPickup?.imageUrl);
    add(entry?.proofOfDelivery?.imageUrl);
  }
  return [...keys];
}

/**
 * Removes a deleted load's photos from storage. A key that another load still
 * uses (a reference can be copied onto another load) is kept. Never throws:
 * the load is already deleted, so a storage hiccup only leaves a file behind.
 */
export async function deletePhotosOfDeletedLoad(keys: string[], deletedLoadId: unknown): Promise<number> {
  if (!keys.length) return 0;
  try {
    const stillUsed = new Set<string>();
    const others = await Load.find({
      _id: { $ne: deletedLoadId },
      $or: [
        { "proofOfPickup.imageUrl": { $in: keys } },
        { "proofOfDelivery.imageUrl": { $in: keys } },
        { "vehicles.inspectionPhotoUrl": { $in: keys } },
        { "conditionReports.photos.key": { $in: keys } },
        { "assignmentHistory.proofOfPickup.imageUrl": { $in: keys } },
        { "assignmentHistory.proofOfDelivery.imageUrl": { $in: keys } },
      ],
    })
      .select("+assignmentHistory proofOfPickup proofOfDelivery vehicles conditionReports")
      .lean();
    for (const other of others) for (const key of collectLoadPhotoKeys(other)) stillUsed.add(key);

    let deleted = 0;
    for (const key of keys) {
      if (stillUsed.has(key)) continue;
      try {
        await storageService.delete(key, BucketType.PRIVATE);
        deleted += 1;
      } catch (error) {
        logger.warn({ error, key }, "Non-fatal: a deleted load's photo could not be removed from storage");
      }
    }
    return deleted;
  } catch (error) {
    logger.error({ error, loadId: String(deletedLoadId) }, "Non-fatal: deleted load's photos were not cleaned up");
    return 0;
  }
}
