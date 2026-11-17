import mongoose from 'mongoose';
import ActivityInterval from '../models/ActivityInterval.model';
import AgentHeartbeat from '../models/AgentHeartbeat.model';

const CLOCK_DRIFT_TOLERANCE_MS = 60 * 60 * 1000;
const RESENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const LIVE_HEARTBEAT_MS = 5 * 60 * 1000;
export const UNSENT_LOOKBACK_MS = 2 * 60 * 60 * 1000;

type UserIdLike = mongoose.Types.ObjectId | string;

export interface LiveHeartbeatLike {
  lastSeenAt?: Date | string | null;
  isIdle?: boolean | null;
  isOnBreak?: boolean | null;
  currentIntervalStartAt?: Date | string | null;
  unsentActivitySince?: Date | string | null;
}

export type SaveIntervalOutcome = 'created' | 'extended' | 'duplicate';

export function parseIntervalDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function looksLikeWrongClientClock(end: Date, serverNow: Date, resent: boolean): boolean {
  const ageMs = serverNow.getTime() - end.getTime();
  if (resent && ageMs >= -FUTURE_TOLERANCE_MS && ageMs <= RESENT_MAX_AGE_MS) return false;
  return Math.abs(ageMs) > CLOCK_DRIFT_TOLERANCE_MS;
}

export async function saveActivityInterval(input: {
  userId: UserIdLike;
  shiftDate: string;
  start: Date;
  end: Date;
}): Promise<{ durationSeconds: number; outcome: SaveIntervalOutcome }> {
  const durationSeconds = Math.round((input.end.getTime() - input.start.getTime()) / 1000);
  const existing = await ActivityInterval.findOne({ userId: input.userId, startAt: input.start })
    .select('_id endAt')
    .lean();

  if (existing) {
    if (new Date(existing.endAt).getTime() >= input.end.getTime()) {
      return { durationSeconds: 0, outcome: 'duplicate' };
    }
    await ActivityInterval.updateOne({ _id: existing._id }, { $set: { endAt: input.end, durationSeconds } });
    return { durationSeconds, outcome: 'extended' };
  }

  await ActivityInterval.create({
    userId: input.userId,
    shiftDate: input.shiftDate,
    startAt: input.start,
    endAt: input.end,
    durationSeconds,
  });
  return { durationSeconds, outcome: 'created' };
}

export function liveTrackingStartMs(heartbeat: LiveHeartbeatLike | null | undefined, nowMs: number = Date.now()): number | null {
  if (!heartbeat || heartbeat.isIdle || heartbeat.isOnBreak || !heartbeat.lastSeenAt) return null;
  if (nowMs - new Date(heartbeat.lastSeenAt).getTime() > LIVE_HEARTBEAT_MS) return null;

  const toMs = (value: Date | string | null | undefined): number | null => {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) && ms <= nowMs ? ms : null;
  };

  const currentStart = toMs(heartbeat.currentIntervalStartAt);
  const unsentStart = toMs(heartbeat.unsentActivitySince);
  const usableUnsentStart = unsentStart !== null && nowMs - unsentStart <= UNSENT_LOOKBACK_MS ? unsentStart : null;

  const starts = [currentStart, usableUnsentStart].filter((ms): ms is number => ms !== null);
  return starts.length ? Math.min(...starts) : null;
}

export async function getLiveTrackingStartMs(userId: UserIdLike): Promise<number | null> {
  const heartbeat = await AgentHeartbeat.findOne({ userId })
    .select('lastSeenAt isIdle isOnBreak currentIntervalStartAt unsentActivitySince')
    .lean();
  return liveTrackingStartMs(heartbeat);
}
