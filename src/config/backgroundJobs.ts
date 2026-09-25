type Env = Record<string, string | undefined>;

export const areBackgroundJobsDisabled = (env: Env = process.env): boolean =>
  (env.DISABLE_SCHEDULERS ?? '').trim().toLowerCase() === 'true';
