jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn(), fatal: jest.fn(), warn: jest.fn(), info: jest.fn() } }));

import { AMAZON_REQUEST_TIMEOUT_MS, preciseEnoughForAStop, withTimeLimit } from '../../src/services/loadRoute.service';

describe('time limit on Amazon Location requests', () => {
  afterEach(() => jest.useRealTimers());

  it('gives a quick answer straight back and leaves no timer running', async () => {
    jest.useFakeTimers();
    await expect(withTimeLimit(async () => 'route')).resolves.toBe('route');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('counts a request that takes too long as failed and cancels it', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = withTimeLimit((abortSignal) => {
      signal = abortSignal;
      return new Promise(() => {});
    });
    jest.advanceTimersByTime(AMAZON_REQUEST_TIMEOUT_MS);
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(signal?.aborted).toBe(true);
  });

  it('keeps Amazon’s own error when it fails within the time limit', async () => {
    jest.useFakeTimers();
    const refused = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    await expect(withTimeLimit(async () => Promise.reject(refused))).rejects.toBe(refused);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('address matches used to place a stop', () => {
  it('accepts street-level matches and finer', () => {
    for (const type of ['PointAddress', 'InterpolatedAddress', 'SecondaryAddress', 'Street', 'Intersection', 'PointOfInterest']) {
      expect(preciseEnoughForAStop(type)).toBe(true);
    }
  });

  it('refuses a whole city, ZIP code, county, state or country', () => {
    for (const type of ['Locality', 'PostalCode', 'SubRegion', 'Region', 'Country', 'District', 'SubDistrict']) {
      expect(preciseEnoughForAStop(type)).toBe(false);
    }
  });

  it('accepts a match that does not say how precise it is', () => {
    expect(preciseEnoughForAStop(undefined)).toBe(true);
  });
});
