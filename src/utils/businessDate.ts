/**
 * Transportation runs on the America/Denver business calendar (MST/MDT).
 * These helpers derive calendar dates in that zone regardless of the API
 * server's own timezone.
 */
export const BUSINESS_TIME_ZONE = "America/Denver";

const businessDatePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function businessDateParts(date: Date = new Date()) {
  const values: Record<string, string> = {};
  for (const part of businessDatePartsFormatter.formatToParts(date)) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return { year: values.year, month: values.month, day: values.day };
}

/** YYYYMMDD in America/Denver, e.g. for load numbers. */
export function businessDateCompactKey(date: Date = new Date()) {
  const { year, month, day } = businessDateParts(date);
  return `${year}${month}${day}`;
}
