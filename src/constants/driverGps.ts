/**
 * Driver GPS time limits, in one place so every screen and check agrees.
 */

/**
 * A position counts as live ("Fresh GPS") for this long. The Driver Tracker
 * frontend uses the same value (LOCATION_FRESH_MS in lib/driver-tracking-view.ts).
 */
export const GPS_LIVE_MS = 90 * 1000;

/** A position this recent is still good enough to estimate distance to a pickup. */
export const GPS_RECENT_FOR_DISTANCE_MS = 5 * 60 * 1000;

/**
 * No GPS for this long on a tracked load raises the "Driver Is Not Sharing
 * Location" alert, and a pickup / start route / delivery is flagged as taken
 * without recent GPS.
 */
export const GPS_SILENCE_ALERT_MS = 10 * 60 * 1000;
