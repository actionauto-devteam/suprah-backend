import {
  NonRetryableOutboxError,
  OUTBOX_MAX_ATTEMPTS,
  decideOutboxFailure,
  isNonRetryableOutboxError,
  outboxRetryDelayMs,
} from '../../src/services/loadLifecycleOutboxPolicy';

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
