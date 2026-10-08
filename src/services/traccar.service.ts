import { getTraccarConfig, ipAllowed, TraccarConfig } from "../config/traccar";
import { forwardSecretMatches } from "./traccarForwardGuard";
import DriverTrackingDevice from "../models/DriverTrackingDevice.model";
import User from "../models/User.model";
import logger from "../utils/logger";
import { ingestDriverLocation } from "./driverLocationIngest.service";

/*
 * Traccar Server integration (per Traccar's official docs):
 * - Primary: Traccar Server forwards each new position to Suprah as JSON
 *   (forward.type=json, forward.url, and forward.header carrying
 *   "Authorization: Bearer <TRACCAR_FORWARD_SECRET>"). The payload holds a
 *   "position" and a "device" object in Traccar's API model.
 * - Catch-up: after an outage Suprah reads GET /api/positions (the last known
 *   position of every device Suprah's Traccar account can see).
 * - Device management: POST /api/devices on approval, PUT disabled=true on revoke.
 * Traccar reports speed in knots, distances in metres, times in ISO 8601.
 * The dispatcher's browser never talks to Traccar.
 */

const REQUEST_TIMEOUT_MS = 10_000;
export const KNOTS_TO_METERS_PER_SECOND = 0.514444;
const FUTURE_TOLERANCE_MS = 60_000;

export interface TraccarDevice {
  id: number;
  name?: string;
  uniqueId: string;
  disabled?: boolean;
  [key: string]: unknown;
}

export interface TraccarPosition {
  id?: number;
  deviceId?: number;
  fixTime?: string;
  deviceTime?: string;
  valid?: boolean;
  latitude?: number;
  longitude?: number;
  /** Knots. */
  speed?: number;
  /** Degrees. */
  course?: number;
  /** Metres; 0 means unknown. */
  accuracy?: number;
}

// ─── Health (per server process; shown in System Stats) ─────────────────────

const health = {
  lastForwardAt: null as Date | null,
  lastReconcileAt: null as Date | null,
  lastReconcileError: null as string | null,
  lastApiError: null as string | null,
  counts: {
    forwarded: 0,
    accepted: 0,
    rejected: 0,
    unknownDevice: 0,
    addressRefused: 0,
    unauthorized: 0,
    malformed: 0,
    reconciled: 0,
  },
};

export function traccarHealthSnapshot() {
  const config = getTraccarConfig();
  return {
    enabled: config.enabled,
    usable: config.usable,
    settingsNeedingAttention: config.problems,
    lastForwardAt: health.lastForwardAt,
    lastReconcileAt: health.lastReconcileAt,
    lastReconcileError: health.lastReconcileError,
    lastApiError: health.lastApiError,
    counts: { ...health.counts },
  };
}

/** Test helper: clears the in-memory health counters. */
export function resetTraccarHealthForTests() {
  health.lastForwardAt = null;
  health.lastReconcileAt = null;
  health.lastReconcileError = null;
  health.lastApiError = null;
  for (const key of Object.keys(health.counts) as Array<keyof typeof health.counts>) health.counts[key] = 0;
}

// ─── Traccar API client ──────────────────────────────────────────────────────

export class TraccarApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function describeStatus(status: number) {
  if (status === 401 || status === 403) {
    return "Traccar Server refused Suprah's API token. Check TRACCAR_API_TOKEN and that account's permissions.";
  }
  if (status === 404) return "Traccar Server doesn't have that device.";
  if (status === 400) return "Traccar Server rejected the request.";
  return `Traccar Server answered with an error (HTTP ${status}).`;
}

async function traccarRequest<T>(config: TraccarConfig, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new TraccarApiError(response.status, describeStatus(response.status));
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  } catch (error) {
    const failure =
      error instanceof TraccarApiError
        ? error
        : new TraccarApiError(0, controller.signal.aborted ? "Traccar Server didn't answer in time." : "Traccar Server couldn't be reached.");
    health.lastApiError = failure.message;
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

function usableConfig(): TraccarConfig {
  const config = getTraccarConfig();
  if (!config.usable) throw new TraccarApiError(0, "The Traccar integration is off or not fully configured.");
  return config;
}

/** Adds (or re-enables) the device on Traccar Server; returns Traccar's device id. */
export async function addTraccarDevice(uniqueId: string, name: string): Promise<number> {
  const config = usableConfig();
  // A retried approval may find the device already there.
  const existing = await traccarRequest<TraccarDevice[]>(config, "GET", `/devices?uniqueId=${encodeURIComponent(uniqueId)}`);
  const found = Array.isArray(existing) ? existing.find((device) => device?.uniqueId === uniqueId) : undefined;
  if (found?.id) {
    if (found.disabled) await traccarRequest(config, "PUT", `/devices/${found.id}`, { ...found, disabled: false });
    return found.id;
  }
  const created = await traccarRequest<TraccarDevice>(config, "POST", "/devices", { name, uniqueId });
  if (!created?.id) throw new TraccarApiError(0, "Traccar Server didn't return the new device.");
  return created.id;
}

/** Disables the device on Traccar Server so it stops accepting its positions. */
export async function disableTraccarDevice(traccarDeviceId: number): Promise<void> {
  const config = usableConfig();
  const found = await traccarRequest<TraccarDevice[]>(config, "GET", `/devices?id=${encodeURIComponent(String(traccarDeviceId))}`);
  const device = Array.isArray(found) ? found.find((item) => item?.id === traccarDeviceId) : undefined;
  if (!device || device.disabled) return;
  await traccarRequest(config, "PUT", `/devices/${traccarDeviceId}`, { ...device, disabled: true });
}

// ─── Positions (forwarded or caught up) ──────────────────────────────────────

export type TraccarPositionOutcome = { accepted: boolean; reason?: string };

async function ingestTraccarPosition(uniqueId: string, position: TraccarPosition): Promise<TraccarPositionOutcome> {
  // Traccar phones only: a tracking-app device never sends through Traccar.
  const link: any = await DriverTrackingDevice.findOne({ uniqueId, status: "active", provider: { $ne: "app" } })
    .select("_id driverId")
    .lean();
  if (!link) {
    health.counts.unknownDevice += 1;
    return { accepted: false, reason: "unknown_or_unapproved_device" };
  }
  const driver = await User.exists({ _id: link.driverId, role: "driver", isActive: true });
  if (!driver) {
    health.counts.rejected += 1;
    return { accepted: false, reason: "driver_account_inactive" };
  }
  if (position.valid === false) {
    health.counts.rejected += 1;
    return { accepted: false, reason: "invalid_fix" };
  }

  const measuredAt = new Date(String(position.fixTime ?? position.deviceTime ?? ""));
  const measuredMs = measuredAt.getTime();
  // Remember the newest position this phone sent, even when Suprah doesn't
  // keep it (no active load): the driver's "you can turn it off" reminder uses it.
  if (Number.isFinite(measuredMs) && measuredMs <= Date.now() + FUTURE_TOLERANCE_MS) {
    await DriverTrackingDevice.updateOne(
      { _id: link._id, $or: [{ lastPositionAt: null }, { lastPositionAt: { $lt: measuredAt } }] },
      { $set: { lastPositionAt: measuredAt } },
    );
  }

  const speedKnots = typeof position.speed === "number" && Number.isFinite(position.speed) ? position.speed : null;
  const result = await ingestDriverLocation({
    driverId: String(link.driverId),
    source: "traccar",
    sourceDeviceId: uniqueId,
    lat: Number(position.latitude),
    lng: Number(position.longitude),
    measuredAt,
    receivedAt: new Date(),
    accuracy: typeof position.accuracy === "number" && position.accuracy > 0 ? position.accuracy : null,
    speed: speedKnots === null ? null : speedKnots * KNOTS_TO_METERS_PER_SECOND,
    heading: typeof position.course === "number" ? position.course : null,
  });
  if (result.accepted) {
    health.counts.accepted += 1;
    return { accepted: true };
  }
  health.counts.rejected += 1;
  return { accepted: false, reason: result.reason };
}

// Moved to traccarForwardGuard (shared with the global rate limit); kept here for existing imports.
export { forwardSecretMatches };

/**
 * One forwarded position from Traccar Server. Answers 2xx for anything a
 * retry can't fix (unknown phone, invalid fix, no active load), so Traccar's
 * retry queue isn't filled with positions Suprah will never take.
 */
export async function processTraccarForward(
  authorization: unknown,
  body: any,
  clientIp?: unknown,
): Promise<{ status: number; body: TraccarPositionOutcome }> {
  const config = getTraccarConfig();
  if (!config.usable) return { status: 503, body: { accepted: false, reason: "integration_off" } };
  // Only our Traccar Server's address may forward (TRACCAR_FORWARD_ALLOWED_IPS).
  if (!ipAllowed(clientIp, config.forwardAllowedIps)) {
    health.counts.addressRefused += 1;
    logger.warn("Traccar forward refused: sender address not allowed");
    return { status: 403, body: { accepted: false, reason: "address_not_allowed" } };
  }
  if (!forwardSecretMatches(authorization, config.forwardSecret)) {
    health.counts.unauthorized += 1;
    logger.warn("Traccar forward refused: missing or wrong secret");
    return { status: 401, body: { accepted: false, reason: "unauthorized" } };
  }

  health.lastForwardAt = new Date();
  health.counts.forwarded += 1;
  const position: TraccarPosition | undefined = body?.position;
  const uniqueId = typeof body?.device?.uniqueId === "string" ? body.device.uniqueId.trim() : "";
  if (!position || typeof position !== "object" || !uniqueId) {
    health.counts.malformed += 1;
    return { status: 202, body: { accepted: false, reason: "malformed" } };
  }

  const outcome = await ingestTraccarPosition(uniqueId, position);
  return { status: outcome.accepted ? 200 : 202, body: outcome };
}

/**
 * Catch-up after an outage or a missed forward: takes the last known position
 * of each approved phone from Traccar Server. Positions Suprah has already
 * seen are skipped, so this never resets "driver offline" alert state.
 */
export async function reconcileTraccarPositions(): Promise<void> {
  const config = getTraccarConfig();
  if (!config.usable) return;
  try {
    const links: any[] = await DriverTrackingDevice.find({ status: "active", traccarDeviceId: { $ne: null } })
      .select("uniqueId traccarDeviceId lastPositionAt")
      .lean();
    if (links.length) {
      const byDeviceId = new Map(links.map((link) => [Number(link.traccarDeviceId), link]));
      const positions = await traccarRequest<TraccarPosition[]>(config, "GET", "/positions");
      for (const position of Array.isArray(positions) ? positions : []) {
        const link = byDeviceId.get(Number(position?.deviceId));
        if (!link) continue;
        const measuredMs = new Date(String(position.fixTime ?? position.deviceTime ?? "")).getTime();
        const seenMs = link.lastPositionAt ? new Date(link.lastPositionAt).getTime() : Number.NEGATIVE_INFINITY;
        if (!Number.isFinite(measuredMs) || measuredMs <= seenMs) continue;
        const outcome = await ingestTraccarPosition(link.uniqueId, position);
        if (outcome.accepted) health.counts.reconciled += 1;
      }
    }
    health.lastReconcileAt = new Date();
    health.lastReconcileError = null;
  } catch (error) {
    health.lastReconcileError = error instanceof TraccarApiError ? error.message : "Catch-up failed.";
    logger.warn({ reason: health.lastReconcileError }, "Traccar catch-up failed");
  }
}

let reconcileTimer: NodeJS.Timeout | null = null;
let reconcileRunning = false;

/**
 * Runs the catch-up (and retries of device updates that failed) on a timer.
 * Does nothing while the integration is off; the timer re-checks each run, so
 * turning it on only needs a restart.
 */
export function startTraccarReconcileWorker(retryDeviceSyncs: () => Promise<void>) {
  if (reconcileTimer) return;
  const config = getTraccarConfig();
  if (!config.usable) {
    if (config.enabled) {
      logger.warn({ settings: config.problems }, "[Traccar] Integration switched on but not fully configured; staying off");
    }
    return;
  }
  const run = async () => {
    if (reconcileRunning) return;
    reconcileRunning = true;
    try {
      await retryDeviceSyncs();
      await reconcileTraccarPositions();
    } finally {
      reconcileRunning = false;
    }
  };
  const first = setTimeout(() => void run(), 20_000);
  first.unref?.();
  reconcileTimer = setInterval(() => void run(), config.reconcileIntervalMs);
  reconcileTimer.unref?.();
  logger.info({ intervalSeconds: config.reconcileIntervalMs / 1000 }, "[Traccar] Catch-up worker started");
}
