import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import config from '../../src/config';
import tokenService from '../../src/services/token.service';
import { resolveCrmJwtSecret } from '../../src/utils/crmJwtSecret';
import {
  GLOBAL_REQUEST_LIMIT,
  SIGNED_IN_REQUEST_LIMIT,
  allowBlockedResponseOrigin,
  globalLimiter,
  globalRequestLimit,
  hasSignedInToken,
} from '../../src/middleware/rate-limit.middleware';

const signedInToken = () =>
  tokenService.generateAccessToken({
    _id: new mongoose.Types.ObjectId(),
    email: 'rate.limit.test@example.com',
    role: 'employee',
    organizationId: new mongoose.Types.ObjectId(),
  });

const withBearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('global request limit', () => {
  const originalCors = (config as any).corsOrigin;
  const originalEnv = (config as any).env;

  afterEach(() => {
    (config as any).corsOrigin = originalCors;
    (config as any).env = originalEnv;
  });

  it('gives a signed-in Suprah or CRM token the higher limit', () => {
    expect(globalRequestLimit(withBearer(signedInToken()))).toBe(SIGNED_IN_REQUEST_LIMIT);
    const crmToken = jwt.sign({ id: String(new mongoose.Types.ObjectId()), type: 'crm' }, resolveCrmJwtSecret(), { expiresIn: '1h' });
    expect(globalRequestLimit(withBearer(crmToken))).toBe(SIGNED_IN_REQUEST_LIMIT);
  });

  it('keeps 1000 for no token, made-up tokens, expired tokens and tokens signed with another secret', () => {
    expect(globalRequestLimit({ headers: {} })).toBe(GLOBAL_REQUEST_LIMIT);
    expect(globalRequestLimit(withBearer('a-made-up-token'))).toBe(GLOBAL_REQUEST_LIMIT);
    const expired = jwt.sign({ sub: 'x', exp: Math.floor(Date.now() / 1000) - 60 }, String(config.jwt.accessSecret || 'access-secret-change-me'));
    expect(hasSignedInToken(withBearer(expired))).toBe(false);
    const forged = jwt.sign({ sub: 'x' }, 'not-the-real-secret', { expiresIn: '1h' });
    expect(globalRequestLimit(withBearer(forged))).toBe(GLOBAL_REQUEST_LIMIT);
    const forgedCrm = jwt.sign({ id: 'x', type: 'crm' }, 'not-the-real-secret', { expiresIn: '1h' });
    expect(globalRequestLimit(withBearer(forgedCrm))).toBe(GLOBAL_REQUEST_LIMIT);
  });

  it('lets the browser read a blocked answer only for allowed sites', () => {
    (config as any).env = 'production';
    (config as any).corsOrigin = 'https://www.suprah-app.com, https://suprah-app.com';
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => { headers[k] = v; }, append: (k: string, v: string) => { headers[k] = v; } };
    allowBlockedResponseOrigin({ headers: { origin: 'https://www.suprah-app.com' } }, res);
    expect(headers).toMatchObject({ 'Access-Control-Allow-Origin': 'https://www.suprah-app.com', 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' });

    const other: Record<string, string> = {};
    allowBlockedResponseOrigin({ headers: { origin: 'https://evil.example' } }, { setHeader: (k: string, v: string) => { other[k] = v; }, append: () => undefined });
    expect(other).toEqual({});
  });

  it('answers a blocked request with a readable 429 and never counts browser pre-checks', async () => {
    const previousSkip = process.env.SKIP_RATE_LIMIT;
    delete process.env.SKIP_RATE_LIMIT;
    (config as any).env = 'production';
    (config as any).corsOrigin = 'https://www.suprah-app.com';
    const app = express();
    app.set('trust proxy', false);
    app.use(globalLimiter);
    app.all('/api/ping', (_req, res) => { res.status(200).json({ ok: true }); });
    try {
      for (let i = 0; i < GLOBAL_REQUEST_LIMIT; i += 1) {
        const ok = await request(app).get('/api/ping').set('Authorization', 'Bearer a-made-up-token-for-the-limit-test');
        expect(ok.status).toBe(200);
      }
      const blocked = await request(app)
        .get('/api/ping')
        .set('Authorization', 'Bearer a-made-up-token-for-the-limit-test')
        .set('Origin', 'https://www.suprah-app.com');
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ success: false, code: 'TOO_MANY_REQUESTS' });
      expect(blocked.body.message).toMatch(/too many requests/i);
      expect(blocked.headers['access-control-allow-origin']).toBe('https://www.suprah-app.com');

      const preCheck = await request(app)
        .options('/api/ping')
        .set('Authorization', 'Bearer a-made-up-token-for-the-limit-test');
      expect(preCheck.status).toBe(200);

      const signedIn = await request(app).get('/api/ping').set('Authorization', `Bearer ${signedInToken()}`);
      expect(signedIn.status).toBe(200);
    } finally {
      if (previousSkip === undefined) delete process.env.SKIP_RATE_LIMIT;
      else process.env.SKIP_RATE_LIMIT = previousSkip;
    }
  }, 120000);
});
