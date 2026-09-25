import fs from 'fs';
import path from 'path';
import { NOTIFICATION_TYPES } from '../../src/constants/notificationTypes';

/**
 * Guards against allowlist drift: every notification / activity type emitted
 * by the Driver Tracker and Load Management code must be accepted by the
 * notification service, the Notification model and the UserActivity model.
 * A missing type used to fail silently and leave lifecycle outbox events
 * retrying forever.
 */
const SRC = path.join(__dirname, '..', '..', 'src');
const read = (relative: string) => fs.readFileSync(path.join(SRC, relative), 'utf8');

const SCANNED_FILES = [
  'controllers/driverTracking.controller.ts',
  'controllers/load.controller.ts',
  'controllers/dispatchChat.controller.ts',
  'controllers/driverStatusChangeRequest.controller.ts',
  'controllers/driverProfile.controller.ts',
  'controllers/driverDirectory.controller.ts',
  'controllers/organization.controller.ts',
  'services/driverLocationMonitor.service.ts',
  'services/driverStatusTransition.service.ts',
  'services/driverVerificationReview.service.ts',
];

const NOTIFICATION_CALL =
  /(lifecycleUserNotificationEvent|lifecycleAdminNotificationEvent|safeCreateNotification(?:Loose)?|createNotification|createLoadLifecycleOutboxEvent\("(?:user|org_admin)_notification",)\(?\s*\{[\s\S]{0,500}?type:\s*["']([a-z_]+)["']/g;
const NOTIFICATION_POSITIONAL = /(notifyOrgAdmins(?:Loose)?|safeBroadcastNotification)\(\s*[\w.]+,\s*["']([a-z_]+)["']/g;
const ACTIVITY_CALL = /lifecycleActivityEvent\(\s*\{[\s\S]{0,400}?type:\s*["']([a-z_]+)["']/g;
const ACTIVITY_POSITIONAL = /logLoadActivity(?:Loose)?\(\s*[^,]+,\s*[^,]+,\s*["']([a-z_]+)["']/g;

function activityEnum(): Set<string> {
  const source = read('models/UserActivity.model.ts').replace(/\r/g, '');
  const start = source.indexOf('enum: [');
  const end = source.indexOf('],', start);
  return new Set([...source.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
}

describe('notification and activity type parity', () => {
  const notificationTypes = new Set<string>(NOTIFICATION_TYPES);
  const activityTypes = activityEnum();

  it('includes the Load lifecycle notification types', () => {
    for (const type of ['load_amendment_required', 'load_picked_up', 'load_in_transit', 'load_delivered']) {
      expect(notificationTypes.has(type)).toBe(true);
    }
  });

  it('uses the shared list in both the service and the model', () => {
    expect(read('services/notification.service.ts')).toContain('VALID_NOTIFICATION_TYPES = NOTIFICATION_TYPES');
    expect(read('models/Notification.model.ts')).toContain('enum: NOTIFICATION_TYPES');
  });

  it('includes reassign/remove activity types', () => {
    expect(activityTypes.has('load_reassigned')).toBe(true);
    expect(activityTypes.has('load_removed')).toBe(true);
  });

  it('every type emitted by driver/load code is accepted', () => {
    const invalid: string[] = [];
    let seenNotifications = 0;
    let seenActivities = 0;

    for (const file of SCANNED_FILES) {
      const source = read(file);
      for (const match of source.matchAll(NOTIFICATION_CALL)) {
        seenNotifications += 1;
        if (!notificationTypes.has(match[2])) invalid.push(`${file}: notification "${match[2]}"`);
      }
      for (const match of source.matchAll(NOTIFICATION_POSITIONAL)) {
        seenNotifications += 1;
        if (!notificationTypes.has(match[2])) invalid.push(`${file}: notification "${match[2]}"`);
      }
      for (const match of source.matchAll(ACTIVITY_CALL)) {
        seenActivities += 1;
        if (!activityTypes.has(match[1])) invalid.push(`${file}: activity "${match[1]}"`);
      }
      for (const match of source.matchAll(ACTIVITY_POSITIONAL)) {
        seenActivities += 1;
        if (!activityTypes.has(match[1])) invalid.push(`${file}: activity "${match[1]}"`);
      }
    }

    // Sanity check that the scan is actually matching call sites.
    expect(seenNotifications).toBeGreaterThan(20);
    expect(seenActivities).toBeGreaterThan(5);
    expect(invalid).toEqual([]);
  });
});
