/**
 * Limits on sending staff invitations (2026-11-11): every invitation is an
 * email sent from Suprah AI, so a runaway or misused admin sign-in can't send
 * floods of email. Normal use passes, each person has their own count, and
 * invitation links and email addresses never go to the logs.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { staffBulkInviteLimiter, staffInviteSendLimiter } from '../../src/middleware/staffInviteRateLimit.middleware';

const SUPPORT_LINE = 'If this keeps happening, contact Suprah AI support at support@suprahai.com.';

function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { _id: req.headers['x-test-user'] };
    next();
  });
  app.post('/action', limiter, (_req, res) => res.status(200).json({ ok: true }));
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ message: err.message }));
  return app;
}

async function sendTimes(app: express.Express, user: string, times: number) {
  const statuses: number[] = [];
  for (let i = 0; i < times; i += 1) {
    statuses.push((await request(app).post('/action').set('x-test-user', user)).status);
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
  ['single invitations', staffInviteSendLimiter, 30, "You've sent a lot of invitations in the last hour. Wait a while, then send the rest."],
  ['Bulk Invite', staffBulkInviteLimiter, 5, "You've used Bulk Invite several times in the last hour. Wait a while, then send the rest."],
])('%s', (name, limiter, max, message) => {
  const app = appWith(limiter);

  it(`allows ${max} in an hour, then explains the wait in plain English`, async () => {
    expect((await sendTimes(app, `${name}-busy`, max)).every((status) => status === 200)).toBe(true);
    const limited = await request(app).post('/action').set('x-test-user', `${name}-busy`);
    expect(limited.status).toBe(429);
    expect(limited.body.message).toBe(`${message} ${SUPPORT_LINE}`);
  });

  it("doesn't slow anyone else down", async () => {
    await sendTimes(app, `${name}-first`, max + 1);
    expect((await request(app).post('/action').set('x-test-user', `${name}-second`)).status).toBe(200);
  });
});

describe('invitation routes and logs', () => {
  const read = (file: string) => fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8').replace(/\s+/g, ' ');

  it('both ways of sending invitations are limited', () => {
    const routes = read('routes/invitation.routes.ts');
    expect(routes).toContain("router.post('/', auth(), staffInviteSendLimiter, createInvitation);");
    expect(routes).toContain("router.post('/bulk', auth(), staffBulkInviteLimiter, bulkCreateInvitations);");
  });

  it('invitation links, tokens and email addresses are never written to the logs', () => {
    const controller = read('controllers/invitation.controller.ts');
    expect(controller).not.toMatch(/console\.(log|error|warn|info)/);
    expect(controller).not.toMatch(/logger\.\w+\(\{[^}]*(email|token|inviteLink)/i);
  });

  it("the invitation link isn't sent back to the admin", () => {
    const controller = read('controllers/invitation.controller.ts');
    expect(controller).not.toContain('Return token for debug/manual sharing');
  });
});
