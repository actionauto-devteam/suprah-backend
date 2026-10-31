export const LIVE_CALL_STATUSES = ['ivr', 'ringing', 'answering', 'in-progress'];
export const LIVE_CALL_WINDOW_MS = 2 * 60 * 60 * 1000;

export const liveCallCutoff = () => new Date(Date.now() - LIVE_CALL_WINDOW_MS);

export function isLiveCall(call: { status?: string; createdAt?: Date | string }): boolean {
  if (!LIVE_CALL_STATUSES.includes(String(call.status))) return false;
  return new Date(call.createdAt || 0).getTime() >= liveCallCutoff().getTime();
}

export const dealershipNumberOf = (call: { direction?: string; from?: string; to?: string }) =>
  (call.direction === 'outbound' ? call.from : call.to) || null;

export const customerNumberOf = (call: { direction?: string; from?: string; to?: string }) =>
  (call.direction === 'outbound' ? call.to : call.from) || null;
