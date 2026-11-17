import config from "../config";

// The storage service names uploads "<milliseconds>-<random number><.ext>".
const GENERATED_NAME = /^\d{10,16}-\d{1,10}(\.[a-z0-9]{1,8})?$/;

/**
 * True when the value points at a file the storage service itself stored in
 * this folder (2026-11-17): its public URL, its local copy or its bucket key.
 *
 * Only such a file may be deleted when it's replaced. Photos copied from
 * elsewhere (a dealership's inventory photos copied into a customer's Garage,
 * a sign-in provider's picture) and anything a browser sent are never ours to
 * delete.
 */
export function isStoredUpload(
  value: unknown,
  folder: string,
  publicUrl: unknown = config.r2?.publicUrl,
): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  const base = typeof publicUrl === "string" ? publicUrl.replace(/\/+$/, "") : "";
  let rest: string | null = null;
  if (base && value.startsWith(`${base}/`)) rest = value.slice(base.length + 1);
  else if (value.startsWith("/uploads/")) rest = value.slice("/uploads/".length);
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.startsWith("/")) rest = value;
  if (rest === null || !rest.startsWith(`${folder}/`)) return false;
  return GENERATED_NAME.test(rest.slice(folder.length + 1));
}
