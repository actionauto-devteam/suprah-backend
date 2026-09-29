export interface SystemMetrics {
  requestsTotal: number;
  errorsTotal: number;
  errors4xx: number;
  errors5xx: number;
  latencies: number[];
  startTime: number;
}

export const metrics: SystemMetrics = {
  requestsTotal: 0,
  errorsTotal: 0,
  errors4xx: 0,
  errors5xx: 0,
  latencies: [],
  startTime: Date.now()
};

/**
 * Driver Tracker health counters since this server process started, shown to
 * platform admins with the other process stats. Counts only: no ids,
 * coordinates or message text.
 */
export const driverTrackerMetrics = {
  loadTransitions: 0,
  loadTransitionsRefused: 0,
  staleLoadWrites: 0,
  outboxDelivered: 0,
  outboxRetries: 0,
  outboxDeadLetters: 0,
  outboxLastLagMs: 0,
  outboxMaxLagMs: 0,
  heartbeatRejects: {} as Record<string, number>,
};

/** Live-connection and sign-in refusal counters since the process started. */
export const connectionMetrics = {
  socketConnections: 0,
  socketDisconnects: {} as Record<string, number>,
  signedOutRefusals: 0,
  notAllowedRefusals: 0,
};

export const countBy = (bucket: Record<string, number>, key: string) => {
  const name = String(key || "unknown").slice(0, 60);
  bucket[name] = (bucket[name] ?? 0) + 1;
};

/** Time from a lifecycle event being queued to it being delivered. */
export const recordOutboxLag = (queuedAt: unknown) => {
  const queued = queuedAt instanceof Date ? queuedAt : new Date(String(queuedAt ?? ""));
  const lag = Date.now() - queued.getTime();
  if (!Number.isFinite(lag) || lag < 0) return;
  driverTrackerMetrics.outboxLastLagMs = lag;
  driverTrackerMetrics.outboxMaxLagMs = Math.max(driverTrackerMetrics.outboxMaxLagMs, lag);
};

export const getPercentile = (data: number[], percentile: number): number => {
  if (data.length === 0) return 0;
  const sorted = [...data].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return Math.round(sorted[index] * 100) / 100;
};
