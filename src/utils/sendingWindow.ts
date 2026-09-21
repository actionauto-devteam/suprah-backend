import { CALENDAR_TZ } from '../constants/calendarTimezone';

const SEND_START_HOUR = 9;
const SEND_END_HOUR = 20;

export function isWithinSendingHours(date: Date = new Date()): boolean {
  const hour =
    parseInt(
      date.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: CALENDAR_TZ }),
      10,
    ) % 24;
  return hour >= SEND_START_HOUR && hour < SEND_END_HOUR;
}
