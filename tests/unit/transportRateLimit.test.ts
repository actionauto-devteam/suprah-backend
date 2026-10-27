/**
 * Rate limits on Driver Tracker, Driver Portal, Dispatch Chat and quote
 * actions: normal use passes, runaway repeats get a plain message with the
 * Suprah AI support contact, and each person has their own count.
 */
import express from 'express';
import request from 'supertest';
import {
  dispatchChatMessageLimiter,
  dispatchChatUploadLimiter,
  driverLoadRequestLimiter,
  quoteChangeLimiter,
} from '../../src/middleware/transportRateLimit.middleware';

const SUPPORT_LINE = 'If this keeps happening, contact Suprah AI support at support@suprahai.com.';

function appWith(limiter: express.RequestHandler, paths: string[] = ['/action']) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { _id: req.headers['x-test-user'] };
    next();
  });
  for (const path of paths) app.post(path, limiter, (_req, res) => res.status(200).json({ ok: true }));
  app.use((err: any, _req: any, res: any, _next: any) =>
    res.status(err.statusCode || 500).json({ message: err.message }),
  );
  return app;
}

async function sendTimes(app: express.Express, user: string, times: number, path = '/action') {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) {
    statuses.push((await request(app).post(path).set('x-test-user', user)).status);
  }
  return statuses;
}

beforeEach(() => {
  process.env.SKIP_RATE_LIMIT = 'false';
});

afterAll(() => {
  delete process.env.SKIP_RATE_LIMIT;
});

describe.each([
  ['Dispatch Chat uploads', dispatchChatUploadLimiter, 30, "You've sent a lot of files in the last few minutes. Wait a few minutes, then send the rest."],
  ['Dispatch Chat messages', dispatchChatMessageLimiter, 30, "You're sending messages very quickly. Wait a minute, then send your message again."],
  ['driver load requests', driverLoadRequestLimiter, 20, "You've requested, cancelled or released loads many times in the last few minutes. Wait a few minutes, then try again."],
  ['quote changes', quoteChangeLimiter, 60, "You've created or changed a lot of quotes in the last few minutes. Wait a few minutes, then try again."],
])('%s', (_name, limiter, max, message) => {
  const app = appWith(limiter);

  it(`allows ${max} in a row, then explains the wait in plain English`, async () => {
    const statuses = await sendTimes(app, `${_name}-busy`, max);
    expect(statuses.every((status) => status === 200)).toBe(true);

    const limited = await request(app).post('/action').set('x-test-user', `${_name}-busy`);
    expect(limited.status).toBe(429);
    expect(limited.body.message).toBe(`${message} ${SUPPORT_LINE}`);
  });

  it("doesn't slow anyone else down", async () => {
    await sendTimes(app, `${_name}-first`, max + 1);
    const other = await request(app).post('/action').set('x-test-user', `${_name}-second`);
    expect(other.status).toBe(200);
  });
});

it('direct Dispatch Chat and channels share one allowance per person', async () => {
  const app = appWith(dispatchChatMessageLimiter, ['/direct', '/channel']);
  expect(await sendTimes(app, 'shared-sender', 20, '/direct')).not.toContain(429);
  expect(await sendTimes(app, 'shared-sender', 10, '/channel')).not.toContain(429);
  const limited = await request(app).post('/channel').set('x-test-user', 'shared-sender');
  expect(limited.status).toBe(429);
});

it('can still be switched off for local testing', async () => {
  process.env.SKIP_RATE_LIMIT = 'true';
  const app = appWith(driverLoadRequestLimiter);
  expect(await sendTimes(app, 'skip-check', 25)).not.toContain(429);
});
