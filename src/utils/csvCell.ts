/**
 * One spreadsheet cell (2026-11-17), with the same rules as Suprah Radar's
 * exports: a value with a comma, quote or line break is quoted with its
 * quotes doubled, and text a spreadsheet would run as a formula (starting
 * with =, +, -, @, a tab or a carriage return) gets a leading apostrophe so it
 * opens as plain text. Numbers are written as they are.
 */
export function csvCell(value: unknown): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = value == null ? "" : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) || safe !== text ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One spreadsheet row. */
export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}
