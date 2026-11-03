/*
 * The customer marketplace's search, filters, sorting and paging (decided
 * 2026-11-02). The endpoint is public, so everything a visitor sends is
 * treated as plain text (never a database pattern), paging is capped, and the
 * dealership's own lead-interest filters aren't available here. Pure, so the
 * rules are testable without a database.
 */

/** The most cars one marketplace page returns. */
export const MARKETPLACE_MAX_LIMIT = 100;
/** Words of a search that are used; the rest are ignored. */
const MAX_SEARCH_WORDS = 6;
/** Longest piece of text used from any one filter or search word. */
const MAX_TEXT_LENGTH = 60;

const escapeForPattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const cleanText = (value: unknown): string => {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" ? text.trim().slice(0, MAX_TEXT_LENGTH) : "";
};

/** A case-insensitive exact match for a dropdown value (make, model, city), or null. */
export function exactText(value: unknown): RegExp | null {
  const text = cleanText(value);
  return text ? new RegExp(`^${escapeForPattern(text)}$`, "i") : null;
}

/** A case-insensitive "contains" match for free text, or null. */
export function containsText(value: unknown): RegExp | null {
  const text = cleanText(value);
  return text ? new RegExp(escapeForPattern(text), "i") : null;
}

/** A finite number from a query value, or undefined. */
export function queryNumber(value: unknown): number | undefined {
  const text = cleanText(value);
  if (!text) return undefined;
  const number = Number(text);
  return Number.isFinite(number) ? number : undefined;
}

/**
 * The search box: every word must appear in the car's make, model, trim, VIN
 * or stock number (any part of the word, so "cam" finds Camry), and a
 * four-digit word may also be the model year. Null when there's nothing to search.
 */
export function marketplaceSearchClause(search: unknown): Record<string, unknown> | null {
  const words = cleanText(search).split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS);
  if (!words.length) return null;
  return {
    $and: words.map((word) => {
      const pattern = new RegExp(escapeForPattern(word.slice(0, MAX_TEXT_LENGTH)), "i");
      const anyField: Record<string, unknown>[] = [
        { make: pattern },
        { modelName: pattern },
        { trim: pattern },
        { vin: pattern },
        { stockNumber: pattern },
      ];
      if (/^\d{4}$/.test(word)) anyField.push({ year: Number(word) });
      return { $or: anyField };
    }),
  };
}

/** The page number and size, kept within safe bounds. */
export function marketplacePaging(page: unknown, limit: unknown): { pageNum: number; limitNum: number; skip: number } {
  const pageNum = Math.max(1, Math.floor(queryNumber(page) ?? 1));
  const requested = Math.floor(queryNumber(limit) ?? 20);
  const limitNum = Math.min(MARKETPLACE_MAX_LIMIT, Math.max(1, requested));
  return { pageNum, limitNum, skip: (pageNum - 1) * limitNum };
}

const SORT_FIELDS: Record<string, string[]> = {
  recent: ["dateAdded"],
  year: ["year"],
  price: ["price"],
  mileage: ["mileage"],
  make: ["make", "modelName"],
  location: ["dealerCity", "dealerState"],
  // "Most Popular": by how many inquiries each car has.
  demand: ["leadCount"],
};

/**
 * The sort for a marketplace page. Unknown sorts fall back to newest listings
 * first; with no direction given, newest listings come first and everything
 * else goes low to high. Ends with the id so paging is stable.
 */
export function marketplaceSort(sortBy: unknown, sortOrder: unknown): { key: string; sort: Record<string, 1 | -1> } {
  const requested = cleanText(sortBy);
  const key = SORT_FIELDS[requested] ? requested : "recent";
  const direction = cleanText(sortOrder);
  const order: 1 | -1 = direction === "asc" ? 1 : direction === "desc" ? -1 : key === "recent" ? -1 : 1;
  const sort: Record<string, 1 | -1> = {};
  for (const field of SORT_FIELDS[key]) sort[field] = order;
  sort._id = order;
  return { key, sort };
}
