import { BUSINESS_TIME_ZONE } from "../utils/businessDate";
import { TracePoint, cleanTrace, distanceMeters } from "./routeTrace.service";

/*
 * The parts of an arrival time that don't need Amazon Location: how the
 * driver is actually moving, whether they're stopped, how heavy the traffic
 * is, and whether they'll make the deadline. Kept separate so each rule can
 * be checked on its own.
 */

/** A driver who hasn't left this circle for STOPPED_MIN_MS counts as stopped. */
export const STOPPED_RADIUS_METERS = 150;
export const STOPPED_MIN_MS = 5 * 60_000;
/** The driver's own pace only counts with at least this much recent driving. */
const PACE_MIN_ELAPSED_MS = 10 * 60_000;
const PACE_MIN_DISTANCE_METERS = 3_000;
/** Near the stop the route time alone is the better estimate. */
const PACE_MIN_REMAINING_METERS = 5_000;
/** How far the driver's own pace may move the estimate: 15% earlier to 25% later, applied at half strength. */
const PACE_FACTOR_MIN = 0.85;
const PACE_FACTOR_MAX = 1.25;
const PACE_WEIGHT = 0.5;
/** Within this long of the end of the deadline day counts as "at risk". */
export const AT_RISK_WINDOW_MS = 2 * 60 * 60_000;

/** How long the driver has stayed within STOPPED_RADIUS_METERS of where they are now. */
export function stoppedForMs(trace: TracePoint[], nowMs: number): number {
  const cleaned = cleanTrace(trace);
  const latest = cleaned[cleaned.length - 1];
  if (!latest) return 0;
  let since = latest.measuredAt.getTime();
  for (let index = cleaned.length - 2; index >= 0; index -= 1) {
    if (distanceMeters(cleaned[index], latest) > STOPPED_RADIUS_METERS) break;
    since = cleaned[index].measuredAt.getTime();
  }
  // Still there now, as far as we know: count up to the present.
  return Math.max(0, nowMs - since);
}

/**
 * Adjusts the route's driving time by how fast this driver has actually been
 * going over the recent stretch compared with the route's expected speed.
 * Returns the adjustment in seconds (positive = later). Small, bounded, and
 * skipped without enough recent driving or close to the stop.
 */
export function paceAdjustmentSeconds(input: {
  routeDurationSeconds: number;
  routeDistanceMeters: number;
  recent: TracePoint[];
  stopped: boolean;
}): number {
  const { routeDurationSeconds, routeDistanceMeters, recent, stopped } = input;
  if (stopped || routeDurationSeconds <= 0 || routeDistanceMeters < PACE_MIN_REMAINING_METERS) return 0;
  const cleaned = cleanTrace(recent);
  if (cleaned.length < 2) return 0;
  const elapsedMs = cleaned[cleaned.length - 1].measuredAt.getTime() - cleaned[0].measuredAt.getTime();
  let travelled = 0;
  for (let index = 1; index < cleaned.length; index += 1) travelled += distanceMeters(cleaned[index - 1], cleaned[index]);
  if (elapsedMs < PACE_MIN_ELAPSED_MS || travelled < PACE_MIN_DISTANCE_METERS) return 0;

  const actualSpeed = travelled / (elapsedMs / 1000);
  const expectedSpeed = routeDistanceMeters / routeDurationSeconds;
  if (actualSpeed <= 0 || expectedSpeed <= 0) return 0;
  const factor = Math.min(PACE_FACTOR_MAX, Math.max(PACE_FACTOR_MIN, expectedSpeed / actualSpeed));
  return Math.round(routeDurationSeconds * PACE_WEIGHT * (factor - 1));
}

/** Traffic compared with free-flowing roads: light under 10% slower, moderate under 30%, heavy beyond. */
export function trafficLevel(durationSeconds: number, freeFlowSeconds: number | null): "light" | "moderate" | "heavy" {
  if (!freeFlowSeconds || freeFlowSeconds <= 0 || durationSeconds <= freeFlowSeconds) return "light";
  const slower = (durationSeconds - freeFlowSeconds) / freeFlowSeconds;
  return slower < 0.1 ? "light" : slower < 0.3 ? "moderate" : "heavy";
}

function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** The last moment of a calendar day (YYYY-MM-DD) on the company's calendar (Mountain Time). */
export function endOfBusinessDayMs(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, date, 23, 59, 59);
  return guess - zoneOffsetMs(guess, BUSINESS_TIME_ZONE);
}

/** Load dates are stored as calendar days at UTC midnight (load.validation). */
export function loadDateDay(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(value as string);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export type DeadlineStatus = "on_time" | "at_risk" | "late";

export function deadlineStatus(arrivalMs: number, day: string): DeadlineStatus {
  const end = endOfBusinessDayMs(day);
  if (arrivalMs > end) return "late";
  if (arrivalMs > end - AT_RISK_WINDOW_MS) return "at_risk";
  return "on_time";
}
