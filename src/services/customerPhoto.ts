/**
 * Photos customers see that were uploaded to the public bucket: their garage
 * cars, their car listings and aftermarket products. The address saved with
 * each one points straight at the bucket, which no longer opens them, so
 * they load through GET /api/photos/:folder/:file instead (the same way
 * profile pictures load through /api/crm/avatars).
 */

/** Folder in the photo address → folder in the bucket. Nothing else is served. */
export const CUSTOMER_PHOTO_FOLDERS: Readonly<Record<string, string>> = {
  vehicles: "vehicles",
  "auction-listings": "auction-listings",
  "aftermarket-media": "aftermarket/media",
};

/** Only names in the format uploads create, e.g. "1730000000000-123456789.jpg". */
const PHOTO_FILE_NAME = /^\d{13}-\d{1,10}\.(jpe?g|png|webp|gif)$/i;

const PHOTO_TYPES: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * The bucket key and image type for a photo request, or null when it isn't
 * a customer photo. The type comes from the file name, never from what was
 * stored with the upload, so only images are ever served.
 */
export function customerPhotoKey(folder: string, file: string): { key: string; contentType: string } | null {
  const bucketFolder = Object.prototype.hasOwnProperty.call(CUSTOMER_PHOTO_FOLDERS, folder)
    ? CUSTOMER_PHOTO_FOLDERS[folder]
    : null;
  const match = PHOTO_FILE_NAME.exec(file);
  if (!bucketFolder || !match) return null;
  return { key: `${bucketFolder}/${file}`, contentType: PHOTO_TYPES[match[1].toLowerCase()] };
}
