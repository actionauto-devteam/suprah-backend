import path from "path";

/**
 * Which stored files a delete may touch (2026-11-17).
 *
 * A stored file is either a local copy under the server's uploads folder
 * ("/uploads/<folder>/<name>") or a key in a cloud bucket ("<folder>/<name>").
 * Anything that climbs out of those ("..", backslashes, absolute paths,
 * control characters) is refused, so a value that came from a user can never
 * point a delete at the server's own files or outside the bucket's folders.
 */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** The full path of a local upload, or null when it isn't inside the uploads folder. */
export function localUploadPath(pathOrUrl: string, serverRoot: string): string | null {
  if (typeof pathOrUrl !== "string" || !pathOrUrl.startsWith("/uploads/")) return null;
  if (CONTROL_CHARACTERS.test(pathOrUrl) || pathOrUrl.includes("\\")) return null;
  const uploadsRoot = path.resolve(serverRoot, "uploads");
  const fullPath = path.resolve(serverRoot, `.${pathOrUrl}`);
  return fullPath.startsWith(uploadsRoot + path.sep) ? fullPath : null;
}

/** True for a plain bucket key such as "avatars/1700000000000-12345.png". */
export function isSafeStorageKey(key: string): boolean {
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/") || key.includes("\\") || CONTROL_CHARACTERS.test(key)) return false;
  return !key.split("/").some((part) => part === "" || part === "." || part === "..");
}
