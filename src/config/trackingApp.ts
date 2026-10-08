/*
 * Suprah Driver Tracker app (the company's own Android/iPhone tracking app).
 *
 * Off unless TRACKING_APP_ENABLED=true. While off, phone tracking setup falls
 * back to Traccar (if that is configured) or says it isn't available yet.
 *
 *   TRACKING_APP_ENABLED                 "true" to let drivers pair the app
 *   TRACKING_APP_UPLOAD_INTERVAL_SECONDS how often the app sends its saved
 *                                        positions (10–300, default 30)
 *   TRACKING_APP_LOCATION_INTERVAL_SECONDS how often the app takes a GPS
 *                                        reading while tracking (5–120, default 15)
 *   TRACKING_APP_DOWNLOAD_URL            optional link shown to drivers in the
 *                                        Driver Portal to install the app
 */

type Env = Record<string, string | undefined>;

export type TrackingAppConfig = {
  enabled: boolean;
  uploadIntervalSeconds: number;
  locationIntervalSeconds: number;
  downloadUrl: string | null;
};

/** A pairing code works for this long after the driver asks for it. */
export const PAIRING_CODE_TTL_MS = 15 * 60_000;
/** Most positions the app may send in one upload. */
export const MAX_POSITIONS_PER_UPLOAD = 100;

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function getTrackingAppConfig(env: Env = process.env): TrackingAppConfig {
  const rawUrl = String(env.TRACKING_APP_DOWNLOAD_URL ?? "").trim();
  return {
    enabled: String(env.TRACKING_APP_ENABLED ?? "").trim().toLowerCase() === "true",
    uploadIntervalSeconds: boundedInt(env.TRACKING_APP_UPLOAD_INTERVAL_SECONDS, 30, 10, 300),
    locationIntervalSeconds: boundedInt(env.TRACKING_APP_LOCATION_INTERVAL_SECONDS, 15, 5, 120),
    downloadUrl: /^https:\/\//i.test(rawUrl) ? rawUrl : null,
  };
}
