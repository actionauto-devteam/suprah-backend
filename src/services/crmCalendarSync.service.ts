import CrmUser from '../models/CrmUser.model';
import googleCalendarService, { GOOGLE_MEET_SYNC_VERSION } from './googleCalendar.service';
import { isLocalUiAcceptanceMode } from '../utils/aiOutboundSafety';
import logger from '../utils/logger';

let timer: NodeJS.Timeout | undefined;
let running = false;
const failures = new Map<string, number>();

/** Bounded polling also works when Google webhooks expire or the app is closed. */
export async function syncConnectedCrmCalendars(now = new Date()): Promise<void> {
  if (isLocalUiAcceptanceMode() || running) return;
  running = true;
  try {
    const coolingDown = [...failures].filter(([, retryAt]) => retryAt > now.getTime()).map(([id]) => id);
    const users = await CrmUser.find({ isActive: { $ne: false }, 'googleCalendar.calendarConnected': true,
      ...(coolingDown.length ? { _id: { $nin: coolingDown } } : {}),
      $or: [{ 'googleCalendar.meetRoomsSyncVersion': { $ne: GOOGLE_MEET_SYNC_VERSION } },
        { 'googleCalendar.lastSyncAt': null },
        { 'googleCalendar.lastSyncAt': { $lte: new Date(now.getTime() - 5 * 60_000) } }],
    }).select('_id').sort({ 'googleCalendar.lastSyncAt': 1 }).limit(10).lean();
    const startedAt = Date.now();
    for (const user of users) {
      if (Date.now() - startedAt > 20_000) break;
      const id = String(user._id);
      if ((failures.get(id) ?? 0) > now.getTime()) continue;
      try {
        await googleCalendarService.syncCrmUserCalendar(id);
        failures.delete(id);
      } catch (error) {
        failures.set(id, now.getTime() + 5 * 60_000);
        logger.warn({ error, crmUserId: id }, '[CalendarSync] Sync will retry');
      }
    }
  } finally { running = false; }
}

export function initCrmCalendarSync(): void {
  if (timer) return;
  const tick = () => { void syncConnectedCrmCalendars().catch(error => logger.error({ error }, '[CalendarSync] Sweep failed')); };
  timer = setInterval(tick, 60_000);
  timer.unref();
  tick();
}
