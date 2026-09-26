import { mapKnownError } from '../../src/utils/errorMapping';
import { redactForLog } from '../../src/utils/logRedaction';
import { INVALID_LINK } from '../../src/utils/userMessages';

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
