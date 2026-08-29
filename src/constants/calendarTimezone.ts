/**
 * Single source of truth for the IANA timezone the Suprah Calendar renders
 * in and schedules "day boundary" logic against (notification summary,
 * reminder sweeps). Previously duplicated as a local `const TZ = ...` in
 * three separate files.
 */
export const CALENDAR_TZ = 'America/Denver';
