/**
 * Quote edits and answers when several staff work at once (2026-11-16): a
 * change made from an older view of the quote is refused instead of quietly
 * replacing what someone else saved meanwhile.
 */
export const QUOTE_CHANGED_WHILE_EDITING =
  "Someone else changed this quote while you were editing it, so your changes weren't saved. Close this window and open it again to see the latest version.";

export const QUOTE_STATUS_CHANGED_TYPE = "quote_status_changed";

/** The version of the quote the staff member opened, as a filter (none when not sent). */
export function openedQuoteVersion(expectedUpdatedAt: unknown): { updatedAt?: Date } {
  if (typeof expectedUpdatedAt !== "string" || !expectedUpdatedAt.trim()) return {};
  const opened = new Date(expectedUpdatedAt);
  return Number.isFinite(opened.getTime()) ? { updatedAt: opened } : {};
}

const STATUS_WORDS: Record<string, string> = {
  pending: "Waiting",
  accepted: "Accepted",
  rejected: "Declined",
  booked: "Booked",
};

/** The message when the quote's status changed since the staff member looked at it, or null. */
export function quoteStatusChangedMeanwhile(current: unknown, expected: unknown): string | null {
  if (typeof expected !== "string" || !expected.trim()) return null;
  const now = String(current ?? "").trim();
  if (now === expected.trim()) return null;
  const words = STATUS_WORDS[now] ?? (now || "another status");
  return `Someone else already marked this request ${words} while you were deciding. Refresh to see it, then answer again if it still needs one.`;
}
