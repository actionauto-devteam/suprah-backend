// Tests from the September 25, 2026 push, kept in one file so the deploy's
// test run uses less memory (2026-11-17). Each describe block below is one
// former test file, moved unchanged; only its imports were merged here.

import { businessDateCompactKey } from '../../src/utils/businessDate';
import { mapKnownError } from '../../src/utils/errorMapping';
import { redactForLog } from '../../src/utils/logRedaction';
import { INVALID_LINK } from '../../src/utils/userMessages';
import { NonRetryableOutboxError, OUTBOX_MAX_ATTEMPTS, decideOutboxFailure, isNonRetryableOutboxError, outboxRetryDelayMs } from '../../src/services/loadLifecycleOutboxPolicy';
import fs from 'fs';
import path from 'path';
import { NOTIFICATION_TYPES } from '../../src/constants/notificationTypes';

describe('businessDate.test.ts', () => {
  describe('businessDateCompactKey (America/Denver)', () => {
    it('uses the Denver calendar day, not UTC, late in the evening (MDT)', () => {
      // 2026-09-05 04:30 UTC is 2026-09-04 22:30 MDT (UTC-6).
      expect(businessDateCompactKey(new Date('2026-09-05T04:30:00Z'))).toBe('20260904');
      expect(businessDateCompactKey(new Date('2026-09-05T06:00:00Z'))).toBe('20260905');
    });

    it('uses the Denver calendar day in winter (MST)', () => {
      // 2026-01-15 06:59 UTC is 2026-01-14 23:59 MST (UTC-7).
      expect(businessDateCompactKey(new Date('2026-01-15T06:59:00Z'))).toBe('20260114');
      expect(businessDateCompactKey(new Date('2026-01-15T07:00:00Z'))).toBe('20260115');
    });

    it('handles the DST change days', () => {
      // Spring forward 2026-03-08, fall back 2026-11-01.
      expect(businessDateCompactKey(new Date('2026-03-08T12:00:00Z'))).toBe('20260308');
      expect(businessDateCompactKey(new Date('2026-11-02T06:30:00Z'))).toBe('20261101');
    });
  });
});

describe('errorMappingAndRedaction.test.ts', () => {
  describe('mapKnownError', () => {
    it('maps a malformed ObjectId to 400 without leaking the Mongoose message', () => {
      const mapped = mapKnownError({
        name: 'CastError',
        kind: 'ObjectId',
        path: '_id',
        message: 'Cast to ObjectId failed for value "abc" (type string) at path "_id" for model "Load"',
      });
      expect(mapped).toEqual({ statusCode: 400, message: INVALID_LINK, errorType: 'INVALID_ID' });
      expect(mapped?.message).not.toContain('Cast to ObjectId');
    });

    it('maps a Mongoose ValidationError to 400 with field names only', () => {
      const mapped = mapKnownError({
        name: 'ValidationError',
        errors: {
          type: { path: 'type', kind: 'enum', message: '`load_x` is not a valid enum value' },
          title: { path: 'title', kind: 'required' },
        },
      });
      expect(mapped?.statusCode).toBe(400);
      expect(mapped?.errorType).toBe('VALIDATION_ERROR');
      expect(mapped?.errors).toEqual([
        { field: 'type', kind: 'enum' },
        { field: 'title', kind: 'required' },
      ]);
      expect(mapped?.message).not.toContain('load_x');
    });

    it('maps a duplicate key to 409', () => {
      const mapped = mapKnownError({ name: 'MongoServerError', code: 11000, keyPattern: { organizationId: 1, loadNumber: 1 } });
      expect(mapped?.statusCode).toBe(409);
      expect(mapped?.errors).toEqual([{ fields: ['organizationId', 'loadNumber'] }]);
    });

    it('tells the user a file is too large instead of blaming the server', () => {
      const mapped = mapKnownError({ name: 'MulterError', code: 'LIMIT_FILE_SIZE', message: 'File too large', field: 'proof' });
      expect(mapped?.statusCode).toBe(413);
      expect(mapped?.errorType).toBe('FILE_TOO_LARGE');
      expect(mapped?.message).toMatch(/too large.*Choose a smaller file/);
      expect(mapped?.message).not.toMatch(/on our side/);
    });

    it('maps other upload problems to a 400 the user can act on', () => {
      expect(mapKnownError({ name: 'MulterError', code: 'LIMIT_FILE_COUNT' })).toMatchObject({
        statusCode: 400,
        errorType: 'TOO_MANY_FILES',
      });
      const unexpected = mapKnownError({ name: 'MulterError', code: 'LIMIT_UNEXPECTED_FILE', field: 'file' });
      expect(unexpected).toMatchObject({ statusCode: 400, errorType: 'UPLOAD_INVALID' });
      expect(unexpected?.message).toMatch(/contact support/);
    });

    it('leaves explicit ApiError-style errors and unknown errors alone', () => {
      expect(mapKnownError({ name: 'CastError', statusCode: 404 })).toBeNull();
      expect(mapKnownError(new Error('boom'))).toBeNull();
      // Joi-style ValidationError (errors not an object map) is not treated as Mongoose.
      expect(mapKnownError({ name: 'ValidationError', details: [] })).toBeNull();
    });
  });

  describe('redactForLog', () => {
    it('redacts GPS, signatures, chat text and credentials but keeps structure', () => {
      const redacted = redactForLog({
        lat: 39.7392,
        lng: -104.9903,
        locationRecordedAt: '2026-09-25T10:00:00Z',
        signatureDataUrl: 'data:image/png;base64,AAAA',
        signerName: 'Pat Driver',
        content: 'Gate code is 1234',
        password: 'hunter2',
        refreshToken: 'abc',
        loadId: '64b7f0c2a1b2c3d4e5f60718',
        nested: { coords: { lat: 1, lng: 2 }, status: 'idle' },
      }) as Record<string, any>;

      expect(redacted.lat).toBe('[REDACTED]');
      expect(redacted.lng).toBe('[REDACTED]');
      expect(redacted.signatureDataUrl).toBe('[REDACTED]');
      expect(redacted.content).toBe('[REDACTED]');
      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.refreshToken).toBe('[REDACTED]');
      expect(redacted.nested.coords).toBe('[REDACTED]');
      expect(redacted.nested.status).toBe('idle');
      expect(redacted.loadId).toBe('64b7f0c2a1b2c3d4e5f60718');
      expect(redacted.locationRecordedAt).toBe('2026-09-25T10:00:00Z');
    });

    it('truncates data URLs, long strings and long arrays under any key', () => {
      const longText = 'x'.repeat(500);
      const redacted = redactForLog({
        avatar: 'data:image/jpeg;base64,' + 'A'.repeat(1000),
        description: longText,
        ids: Array.from({ length: 30 }, (_, index) => index),
      }) as Record<string, any>;

      expect(redacted.avatar).toMatch(/^\[data-url \d+ chars\]$/);
      expect(redacted.description.length).toBeLessThan(260);
      expect(redacted.ids).toHaveLength(21);
      expect(redacted.ids[20]).toBe('[+10 more]');
    });
  });
});

describe('loadLifecycleOutboxPolicy.test.ts', () => {
  describe('load lifecycle outbox failure policy', () => {
    it('dead-letters errors that can never succeed', () => {
      const nonRetryable = [
        new NonRetryableOutboxError('missing recipient'),
        Object.assign(new Error('Invalid notification type: load_picked_up'), { statusCode: 400 }),
        Object.assign(new Error('Notification target user not found'), { statusCode: 404 }),
        Object.assign(new Error('UserActivity validation failed'), { name: 'ValidationError' }),
        Object.assign(new Error('Cast to ObjectId failed'), { name: 'CastError' }),
        Object.assign(new Error('input must be a 24 character hex string'), { name: 'BSONError' }),
      ];

      for (const error of nonRetryable) {
        expect(isNonRetryableOutboxError(error)).toBe(true);
        expect(decideOutboxFailure(error, 1)).toEqual({ action: 'dead_letter', reason: 'non_retryable' });
      }
    });

    it('retries transient failures with capped exponential backoff', () => {
      const transient = [
        new Error('socket hang up'),
        Object.assign(new Error('Service unavailable'), { statusCode: 503 }),
        Object.assign(new Error('Request timeout'), { statusCode: 408 }),
        Object.assign(new Error('Too many requests'), { statusCode: 429 }),
      ];

      for (const error of transient) {
        expect(isNonRetryableOutboxError(error)).toBe(false);
        expect(decideOutboxFailure(error, 1)).toEqual({ action: 'retry', delayMs: 5_000 });
      }

      expect(outboxRetryDelayMs(2)).toBe(10_000);
      expect(outboxRetryDelayMs(9)).toBe(15 * 60_000);
      expect(outboxRetryDelayMs(50)).toBe(15 * 60_000);
    });

    it('dead-letters transient failures once attempts are exhausted', () => {
      const error = new Error('socket hang up');
      expect(decideOutboxFailure(error, OUTBOX_MAX_ATTEMPTS - 1).action).toBe('retry');
      expect(decideOutboxFailure(error, OUTBOX_MAX_ATTEMPTS)).toEqual({
        action: 'dead_letter',
        reason: 'max_attempts',
      });
    });
  });
});

describe('notificationTypeParity.test.ts', () => {
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
});
