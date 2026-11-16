import mongoose from "mongoose";

/**
 * The saved loads a compatibility preview asks about (2026-11-15): valid IDs
 * only, once each, so they can be fetched in one lookup instead of one query
 * per load (up to 50).
 */
export function previewLoadIds(entries: Array<{ loadId?: unknown } | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = String(entry?.loadId ?? "").trim();
    if (id && mongoose.Types.ObjectId.isValid(id)) ids.add(id);
  }
  return [...ids];
}
