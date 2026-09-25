import { areBackgroundJobsDisabled } from '../../src/config/backgroundJobs';

describe('areBackgroundJobsDisabled', () => {
  it('is off unless the switch is exactly true, so the server behaves as before by default', () => {
    expect(areBackgroundJobsDisabled({})).toBe(false);
    for (const value of ['', 'false', '0', 'yes', '1', 'on', 'off']) {
      expect(areBackgroundJobsDisabled({ DISABLE_SCHEDULERS: value })).toBe(false);
    }
  });

  it('turns the background jobs off for true in any case and ignores surrounding spaces', () => {
    for (const value of ['true', 'TRUE', 'True', ' true ']) {
      expect(areBackgroundJobsDisabled({ DISABLE_SCHEDULERS: value })).toBe(true);
    }
  });

  it('reads the process environment when none is given', () => {
    const saved = process.env.DISABLE_SCHEDULERS;
    process.env.DISABLE_SCHEDULERS = 'true';
    expect(areBackgroundJobsDisabled()).toBe(true);
    if (saved === undefined) delete process.env.DISABLE_SCHEDULERS;
    else process.env.DISABLE_SCHEDULERS = saved;
  });
});
