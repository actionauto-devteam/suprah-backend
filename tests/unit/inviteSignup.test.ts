/**
 * Signing up with a driver or customer invite link (2026-11-11): the new
 * account confirms its email with a 6-digit code first, like every other
 * sign-up, the form only takes a real email and a reasonable name, and one
 * connection can't create accounts endlessly.
 */
import express from 'express';
import request from 'supertest';

const mockTokenFindOne = jest.fn();
const mockUserFindOne = jest.fn();
const mockUserCreate = jest.fn();
const mockOrgFindById = jest.fn();
const mockSendSignupCode = jest.fn();
const mockEnsureDriverRequest = jest.fn();
const mockSendEmail = jest.fn();

jest.mock('../../src/models/CustomerInviteToken.model', () => ({ __esModule: true, default: { findOne: mockTokenFindOne } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findOne: mockUserFindOne, create: mockUserCreate } }));
jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: mockOrgFindById } }));
jest.mock('../../src/models/DealershipInquiry.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/email.service', () => ({ __esModule: true, default: { sendEmail: mockSendEmail } }));
jest.mock('../../src/services/auth.service', () => ({
  __esModule: true,
  default: { sendSignupCode: mockSendSignupCode, ensureDriverRequest: mockEnsureDriverRequest },
}));

import { registerViaInvite } from '../../src/controllers/customerInvite.controller';
import { inviteLinkSignupLimiter } from '../../src/middleware/inviteLinkSignupLimit.middleware';
import {
  EMAIL_ALREADY_HAS_ACCOUNT,
  INVITE_SIGNUP_MESSAGES,
  inviteSignupCodeIntro,
  inviteSignupDetailsProblem,
} from '../../src/utils/inviteSignup';

const ORG_ID = '64b0000000000000000000aa';
const PASSWORD = 'Str0ng!Pass';

function inviteToken(accountType: 'driver' | 'customer') {
  return {
    accountType,
    organizationId: accountType === 'customer' ? ORG_ID : undefined,
    multiUse: true,
    isUsed: false,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    save: jest.fn(),
  };
}

const app = express();
app.use(express.json());
app.post('/invite/:shortCode/register', registerViaInvite);
app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(error.statusCode || 500).json({ message: error.message });
});

const signUp = (body: Record<string, unknown>) => request(app).post('/invite/abc12345/register').send(body);

beforeEach(() => {
  jest.clearAllMocks();
  mockUserFindOne.mockResolvedValue(null);
  mockUserCreate.mockImplementation(async (values: Record<string, unknown>) => ({ _id: 'new-user', ...values }));
  mockOrgFindById.mockReturnValue({ select: () => ({ lean: async () => ({ name: 'Action Auto Utah' }) }) });
  mockSendSignupCode.mockResolvedValue(true);
});

describe('signing up with a driver invite link', () => {
  it("creates a driver account that isn't confirmed yet and emails the code", async () => {
    mockTokenFindOne.mockResolvedValue(inviteToken('driver'));
    const res = await signUp({ name: 'Sam Driver', email: ' Sam@Example.com ', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(mockUserCreate).toHaveBeenCalledWith(expect.objectContaining({ email: 'sam@example.com', role: 'driver', emailVerified: false, isApproved: false }));
    expect(mockSendSignupCode).toHaveBeenCalledWith(expect.objectContaining({ email: 'sam@example.com' }), inviteSignupCodeIntro('driver'));
    expect(res.body.data).toMatchObject({ email: 'sam@example.com', accountType: 'driver', verifyEmail: true, emailSent: true });
    // No other email: the code email is the only one.
    expect(mockSendEmail).not.toHaveBeenCalled();
  });
});

describe('signing up with a customer invite link', () => {
  it("creates a customer account with the dealership that isn't confirmed yet and emails the code", async () => {
    mockTokenFindOne.mockResolvedValue(inviteToken('customer'));
    const res = await signUp({ name: 'Maria Buyer', email: 'maria@example.com', password: PASSWORD });

    expect(res.status).toBe(201);
    expect(mockUserCreate).toHaveBeenCalledWith(expect.objectContaining({ role: 'customer', organizationId: ORG_ID, emailVerified: false }));
    expect(mockSendSignupCode).toHaveBeenCalledWith(expect.anything(), 'Enter this code to confirm your email and open your customer account with Action Auto Utah.');
    expect(res.body.data).toMatchObject({ accountType: 'customer', verifyEmail: true, emailSent: true });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('still creates the account when the code email fails, and says so (Resend Code sends it again)', async () => {
    mockTokenFindOne.mockResolvedValue(inviteToken('customer'));
    mockSendSignupCode.mockResolvedValue(false);
    const res = await signUp({ name: 'Maria Buyer', email: 'maria@example.com', password: PASSWORD });
    expect(res.status).toBe(201);
    expect(res.body.data.emailSent).toBe(false);
  });
});

describe('what the form accepts', () => {
  beforeEach(() => mockTokenFindOne.mockResolvedValue(inviteToken('customer')));

  it('an email that already has an account is told to sign in instead', async () => {
    mockUserFindOne.mockResolvedValue({ _id: 'existing' });
    const res = await signUp({ name: 'Maria Buyer', email: 'maria@example.com', password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe(EMAIL_ALREADY_HAS_ACCOUNT);
    expect(mockUserCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['not an email', { name: 'Maria Buyer', email: 'maria', password: PASSWORD }, INVITE_SIGNUP_MESSAGES.email],
    ['a one-letter name', { name: 'M', email: 'maria@example.com', password: PASSWORD }, INVITE_SIGNUP_MESSAGES.name],
    ['a list instead of an email', { name: 'Maria Buyer', email: ['maria@example.com'], password: PASSWORD }, 'Enter your name, email address and a password, then try again.'],
    ['a missing password', { name: 'Maria Buyer', email: 'maria@example.com' }, 'Enter your name, email address and a password, then try again.'],
  ])('%s gets a plain message and no account', async (_label, body, message) => {
    const res = await signUp(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(mockUserCreate).not.toHaveBeenCalled();
  });
});

describe('the sign-up details and code email words', () => {
  it('a real email and a 2 to 100 character name pass', () => {
    expect(inviteSignupDetailsProblem({ name: 'Al', email: 'al+cars@dealer.co.uk' })).toBeNull();
    expect(inviteSignupDetailsProblem({ name: 'x'.repeat(101), email: 'al@dealer.com' })).toBe(INVITE_SIGNUP_MESSAGES.name);
    expect(inviteSignupDetailsProblem({ name: 'Al', email: 'al@dealer' })).toBe(INVITE_SIGNUP_MESSAGES.email);
    expect(inviteSignupDetailsProblem({ name: 'Al', email: '<b>al</b>@dealer.com' })).toBe(INVITE_SIGNUP_MESSAGES.email);
  });

  it('the code email says what comes next', () => {
    expect(inviteSignupCodeIntro('driver')).toContain('finish your driver application');
    expect(inviteSignupCodeIntro('customer', '  ')).toBe('Enter this code to confirm your email and open your customer account with the dealership.');
    expect(EMAIL_ALREADY_HAS_ACCOUNT).toMatch(/^This email already has a Suprah AI account\. Sign in instead/);
  });
});

describe('accounts created from one connection', () => {
  const limited = express();
  limited.set('trust proxy', 1);
  limited.post('/signup', inviteLinkSignupLimiter, (_req, res) => res.status(201).json({ ok: true }));
  limited.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode || 500).json({ message: error.message });
  });
  const from = (ip: string) => request(limited).post('/signup').set('X-Forwarded-For', ip);

  beforeEach(() => {
    process.env.SKIP_RATE_LIMIT = 'false';
  });
  afterAll(() => {
    delete process.env.SKIP_RATE_LIMIT;
  });

  it('allows 20 an hour, then explains the wait in plain English', async () => {
    for (let i = 0; i < 20; i += 1) expect((await from('203.0.113.7')).status).toBe(201);
    const blocked = await from('203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toBe(
      'A lot of accounts were created from this connection in the last hour. Wait a while, then try again. If this keeps happening, contact Suprah AI support at support@suprahai.com.',
    );
  });

  it("doesn't slow down anyone on another connection", async () => {
    expect((await from('198.51.100.20')).status).toBe(201);
  });

  it('sits on the invite link sign-up route', () => {
    const fs = require('fs');
    const path = require('path');
    const routes = fs.readFileSync(path.join(__dirname, '../../src/routes/auth.routes.ts'), 'utf8');
    expect(routes).toContain("router.post('/invite/:shortCode/register', authLimiter, inviteLinkSignupLimiter, registerViaInvite);");
  });
});
