import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import app from '../src/server';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Organization from '../src/models/Organization.model';
import Session from '../src/models/Session.model';
import CrmExtensionSignInCode from '../src/models/CrmExtensionSignInCode.model';
import { issueCrmSessionToken } from '../src/middleware/crmAuth.middleware';
import tokenService from '../src/services/token.service';
import config from '../src/config';

const stamp = Date.now();
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const PASSWORD = 'ExtPass!2026';
const hash = (code: string) => createHash('sha256').update(code).digest('hex');
const VERIFIER = randomBytes(32).toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

describe('Extension sign-in from the Suprah CRM website (real database)', () => {
  let org: any;
  let linkedMain: any;
  let unlinkedMain: any;
  let crmUser: any;
  let linkedCrmUser: any;
  let laterInactive: any;
  let crmToken = '';

  const createCode = (token?: string, challenge: unknown = CHALLENGE) => {
    const call = request(app).post('/api/crm/extension-sign-in/code');
    return (token ? call.set('Authorization', `Bearer ${token}`) : call).send({ challenge });
  };
  const exchange = (code: unknown, origin = EXT_ORIGIN, verifier: unknown = VERIFIER) =>
    request(app).post('/api/crm/extension/session/exchange').set('Origin', origin).send({ code, verifier });

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) await mongoose.connection.asPromise();
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await CrmExtensionSignInCode.init();
    org = await Organization.create({ name: 'Handoff Motors', slug: `handoff-${stamp}`, status: 'active' });
    linkedMain = await User.create({
      email: `handoff-linked-${stamp}@example.com`, password: 'Password123!', name: 'Linked Rep', role: 'employee',
      organizationId: org._id, emailVerified: true, onboardingCompleted: true, isActive: true,
    });
    unlinkedMain = await User.create({
      email: `handoff-owner-${stamp}@example.com`, password: 'Password123!', name: 'Owner Without CRM', role: 'admin',
      organizationId: org._id, organizationRole: 'admin', emailVerified: true, onboardingCompleted: true, isActive: true,
    });
    crmUser = await CrmUser.create({ organizationId: org._id, fullName: 'Riley Handoff', username: `HO-${stamp}`, email: `handoff-crm-${stamp}@example.com`, password: PASSWORD, role: 'employee', isActive: true });
    linkedCrmUser = await CrmUser.create({ organizationId: org._id, fullName: 'Linked Rep', username: `HO-LINK-${stamp}`, email: linkedMain.email, password: PASSWORD, role: 'employee', isActive: true });
    laterInactive = await CrmUser.create({ organizationId: org._id, fullName: 'Leaving Rep', username: `HO-OFF-${stamp}`, email: `handoff-off-${stamp}@example.com`, password: PASSWORD, role: 'employee', isActive: true });
    crmToken = await issueCrmSessionToken(String(crmUser._id));
  });

  afterAll(async () => {
    const userIds = [crmUser._id, linkedCrmUser._id, laterInactive._id];
    await CrmExtensionSignInCode.deleteMany({ crmUserId: { $in: userIds } });
    await Session.deleteMany({ crmUserId: { $in: userIds } });
    await CrmUser.deleteMany({ _id: { $in: userIds } });
    await User.deleteMany({ organizationId: org._id });
    await Organization.deleteMany({ _id: org._id });
  });

  it('needs a Suprah CRM login to create a sign-in code', async () => {
    await createCode().expect(401);
  });

  it('creates a short-lived one-time code for the signed-in employee and stores only its fingerprint', async () => {
    const res = await createCode(crmToken).expect(200);
    const { code, username, expiresAt } = res.body.data;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(username).toBe(crmUser.username);
    const lifetime = new Date(expiresAt).getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(30 * 1000);
    expect(lifetime).toBeLessThanOrEqual(60 * 1000);
    const stored: any = await CrmExtensionSignInCode.findOne({ codeHash: hash(code) }).lean();
    expect(String(stored.crmUserId)).toBe(String(crmUser._id));
    expect(stored.challenge).toBe(CHALLENGE);
    const all = JSON.stringify(await CrmExtensionSignInCode.find({ crmUserId: crmUser._id }).lean());
    expect(all).not.toContain(code);
    expect(all).not.toContain(VERIFIER);
  });

  it('a code works only together with the secret kept inside the extension that asked for it', async () => {
    await createCode(crmToken, null).expect(400);
    await createCode(crmToken, 'short').expect(400);
    const { code } = (await createCode(crmToken).expect(200)).body.data;
    await exchange(code, EXT_ORIGIN, randomBytes(32).toString('base64url')).expect(401);
    await exchange(code, EXT_ORIGIN, '').expect(401);
    await exchange(code, EXT_ORIGIN, CHALLENGE).expect(401);
    const stored: any = await CrmExtensionSignInCode.findOne({ codeHash: hash(code) }).lean();
    expect(stored.usedAt).toBeNull();
    await exchange(code).expect(200);
  });

  it('the extension trades the code for its normal 8-hour session, and the code works only once', async () => {
    const { code } = (await createCode(crmToken).expect(200)).body.data;
    const res = await exchange(code).expect(200);
    expect(jwt.decode(res.body.data.token)).toEqual(expect.objectContaining({ type: 'crm_ext', id: String(crmUser._id) }));
    expect(res.body.data.user).toEqual({ fullName: 'Riley Handoff', username: crmUser.username, role: 'employee' });
    expect(res.body.data.organization.name).toBe('Handoff Motors');
    const hours = (new Date(res.body.data.expiresAt).getTime() - Date.now()) / 3600e3;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThanOrEqual(8);
    await request(app).get('/api/crm/extension/session').set('Origin', EXT_ORIGIN).set('Authorization', `Bearer ${res.body.data.token}`).expect(200);
    const again = await exchange(code).expect(401);
    expect(again.body.message).toBe('This sign-in expired. Open Suprah CRM again to sign in.');
  });

  it('an employee signed in with their main Suprah account gets a code for their linked CRM account', async () => {
    const mainToken = tokenService.generateAccessToken(linkedMain);
    const res = await createCode(mainToken).expect(200);
    expect(res.body.data.username).toBe(linkedCrmUser.username);
    const session = await exchange(res.body.data.code).expect(200);
    expect(jwt.decode(session.body.data.token)).toEqual(expect.objectContaining({ id: String(linkedCrmUser._id) }));
  });

  it('a main account without a CRM employee record is told to use an Employee ID instead', async () => {
    const res = await createCode(tokenService.generateAccessToken(unlinkedMain)).expect(403);
    expect(res.body.message).toBe("This account can't sign in to the extension automatically. Use your Employee ID instead.");
  });

  it('only the extension can trade a code; a website cannot, and the code stays unused', async () => {
    const { code } = (await createCode(crmToken).expect(200)).body.data;
    await exchange(code, 'https://evil.example').expect(403);
    await exchange(code, 'https://www.suprah-app.com').expect(403);
    const stored: any = await CrmExtensionSignInCode.findOne({ codeHash: hash(code) }).lean();
    expect(stored.usedAt).toBeNull();
    await exchange(code).expect(200);
  });

  it('expired, unknown or malformed codes are refused without creating a session', async () => {
    const { code } = (await createCode(crmToken).expect(200)).body.data;
    await CrmExtensionSignInCode.updateOne({ codeHash: hash(code) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const before = await Session.countDocuments({ crmUserId: crmUser._id });
    await exchange(code).expect(401);
    await exchange('x'.repeat(43)).expect(401);
    await exchange({ $ne: null }).expect(401);
    await exchange('').expect(401);
    expect(await Session.countDocuments({ crmUserId: crmUser._id })).toBe(before);
  });

  it('a code cannot be used by someone who was deactivated after it was made', async () => {
    const token = await issueCrmSessionToken(String(laterInactive._id));
    const { code } = (await createCode(token).expect(200)).body.data;
    await CrmUser.updateOne({ _id: laterInactive._id }, { $set: { isActive: false } });
    const before = await Session.countDocuments({ crmUserId: laterInactive._id });
    await exchange(code).expect(403);
    expect(await Session.countDocuments({ crmUserId: laterInactive._id })).toBe(before);
  });

  it('the CRM website cannot get a code while the extension is switched off for this server', async () => {
    const previousEnv = config.env;
    const previousIds = process.env.CRM_EXTENSION_IDS;
    try {
      (config as any).env = 'production';
      delete process.env.CRM_EXTENSION_IDS;
      const off = await createCode(crmToken).expect(403);
      expect(off.body.message).toBe('The Suprah CRM extension is not turned on for this server yet');
      process.env.CRM_EXTENSION_IDS = 'fjpfmocfeidcflangiebhbmdkfmbloek';
      await createCode(crmToken).expect(200);
    } finally {
      (config as any).env = previousEnv;
      if (previousIds === undefined) delete process.env.CRM_EXTENSION_IDS;
      else process.env.CRM_EXTENSION_IDS = previousIds;
    }
  });
});
