import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Organization from '../src/models/Organization.model';
import Session from '../src/models/Session.model';
import SmsOptOut from '../src/models/SmsOptOut.model';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';
import { issueCrmSessionToken, authTokenHash, CRM_JWT_SECRET } from '../src/middleware/crmAuth.middleware';
import config from '../src/config';
import { extensionApiEnabled, isAllowedExtensionOrigin, parseExtensionIds } from '../src/routes/crmExtension.routes';

const stamp = Date.now();
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const PASSWORD = 'ExtPass!2026';

describe('Suprah CRM extension API (real database)', () => {
    let org: any;
    let otherOrg: any;
    let mainAdmin: any;
    let crmUser: any;
    let inactiveUser: any;
    let otherCrmUser: any;
    let extToken = '';
    let otherExtToken = '';
    const ids: Record<string, any> = {};

    const createLead = (orgId: unknown, doc: Record<string, unknown>) => Lead.create({
        organizationId: orgId,
        createdBy: mainAdmin._id,
        channel: 'sms',
        source: 'Inbound SMS',
        status: 'New',
        ...doc,
    });

    const ext = (method: 'get' | 'post' | 'delete', path: string, token?: string) => {
        const call = request(app)[method](`/api/crm/extension${path}`).set('Origin', EXT_ORIGIN);
        return token ? call.set('Authorization', `Bearer ${token}`) : call;
    };

    beforeAll(async () => {
        if (mongoose.connection.readyState !== 1) await mongoose.connection.asPromise();
        const db = mongoose.connection.db!;
        for (const index of CUSTOMER_IDENTITY_INDEXES) {
            await db.collection(index.collection).createIndex(index.key, {
                name: index.name,
                ...(index.unique ? { unique: true } : {}),
                ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}),
            });
        }
        org = await Organization.create({ name: 'Extension Motors', slug: `ext-${stamp}`, status: 'active' });
        otherOrg = await Organization.create({ name: 'Other Motors', slug: `ext-other-${stamp}`, status: 'active' });
        mainAdmin = await User.create({
            email: `ext-admin-${stamp}@example.com`, password: 'Password123!', name: 'Ext Admin', role: 'admin',
            organizationId: org._id, organizationRole: 'admin', emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        const rep = await User.create({
            email: `ext-rep-${stamp}@example.com`, password: 'Password123!', name: 'Casey Morgan', role: 'employee',
            organizationId: org._id, emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        crmUser = await CrmUser.create({ organizationId: org._id, fullName: 'Taylor Lookup', username: `EXT-${stamp}`, email: `ext-crm-${stamp}@example.com`, password: PASSWORD, role: 'employee', isActive: true });
        inactiveUser = await CrmUser.create({ organizationId: org._id, fullName: 'Gone User', username: `EXT-OFF-${stamp}`, email: `ext-off-${stamp}@example.com`, password: PASSWORD, role: 'employee', isActive: false });
        otherCrmUser = await CrmUser.create({ organizationId: otherOrg._id, fullName: 'Other Rep', username: `EXT-OTHER-${stamp}`, email: `ext-other-${stamp}@example.com`, password: PASSWORD, role: 'employee', isActive: true });

        ids.single = await createLead(org._id, { firstName: 'Avery', lastName: 'Single', phone: '(801) 555-0141', vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma' }, assignedTo: rep._id });
        await Lead.collection.updateOne({ _id: ids.single._id }, { $set: { notes: [
            { text: 'Prefers texts after 5 PM', createdAt: new Date(Date.UTC(2026, 9, 20, 18)), authorName: 'Casey Morgan', authorType: 'user' },
            { text: 'Asked about the TRD package', createdAt: new Date(Date.UTC(2026, 9, 22, 18)), authorName: 'Casey Morgan', authorType: 'user' },
        ] } });
        ids.multiA = await createLead(org._id, { firstName: 'Jordan', lastName: 'Shared', phone: '801.555.0142', status: 'Sold' });
        ids.multiB = await createLead(org._id, { firstName: 'Jamie', lastName: 'Shared', phone: '+1 801 555 0142' });
        ids.foreign = await createLead(otherOrg._id, { firstName: 'Foreign', lastName: 'Lead', phone: '(801) 555-0141' });
        ids.dnc = await createLead(org._id, { firstName: 'Dana', lastName: 'Restricted', phone: '(801) 555-0143', status: 'Do Not Contact' });
        ids.stop = await createLead(org._id, { firstName: 'Sam', lastName: 'Stopped', phone: '(801) 555-0144' });
        await SmsOptOut.create({ organizationId: String(org._id), phone: '+18015550144', optedOut: true });
    });

    afterAll(async () => {
        const orgIds = [org._id, otherOrg._id];
        await SmsOptOut.deleteMany({ organizationId: { $in: orgIds.map(String) } });
        await Lead.deleteMany({ organizationId: { $in: orgIds } });
        await Customer.deleteMany({ organizationId: { $in: orgIds.map(String) } });
        await Session.deleteMany({ crmUserId: { $in: [crmUser._id, inactiveUser._id, otherCrmUser._id] } });
        await CrmUser.deleteMany({ _id: { $in: [crmUser._id, inactiveUser._id, otherCrmUser._id] } });
        await User.deleteMany({ organizationId: { $in: orgIds } });
        await Organization.deleteMany({ _id: { $in: orgIds } });
    });

    it('signs in with the CRM Employee ID and returns a scoped extension token', async () => {
        const res = await ext('post', '/session').send({ username: crmUser.username, password: PASSWORD }).expect(200);
        extToken = res.body.data.token;
        expect(jwt.decode(extToken)).toEqual(expect.objectContaining({ type: 'crm_ext', id: String(crmUser._id) }));
        expect(res.body.data.user).toEqual({ fullName: 'Taylor Lookup', username: crmUser.username, role: 'employee' });
        expect(res.body.data.organization.name).toBe('Extension Motors');
        expect(res.headers['cache-control']).toBe('no-store');
        const session = await Session.findOne({ refreshTokenHash: authTokenHash(extToken) }).lean();
        expect(session).toBeTruthy();
        const other = await ext('post', '/session').send({ username: otherCrmUser.username, password: PASSWORD }).expect(200);
        otherExtToken = other.body.data.token;
    });

    it('rejects bad credentials and deactivated accounts with the same messages as CRM login', async () => {
        const wrong = await ext('post', '/session').send({ username: crmUser.username, password: 'nope' }).expect(401);
        expect(wrong.body.message).toBe('Invalid Employee ID or password');
        await ext('post', '/session').send({ username: inactiveUser.username, password: PASSWORD }).expect(403);
        await ext('post', '/session').send({}).expect(400);
    });

    it('keeps the extension token out of every other CRM API, and the CRM token out of the extension API', async () => {
        await request(app).get('/api/crm/customer-records').set('Authorization', `Bearer ${extToken}`).expect(401);
        await request(app).get('/api/leads').set('Authorization', `Bearer ${extToken}`).expect(401);
        const crmToken = await issueCrmSessionToken(String(crmUser._id));
        await ext('get', '/session', crmToken).expect(401);
        await ext('get', '/session').expect(401);
        const me = await ext('get', '/session', extToken).expect(200);
        expect(me.body.data.user.fullName).toBe('Taylor Lookup');
    });

    it('returns a single match with only the fields the panel needs', async () => {
        const res = await ext('post', '/lookup', extToken).send({ phone: '(801) 555-0141' }).expect(200);
        const data = res.body.data;
        expect(data.query).toEqual({ kind: 'phone', normalizedPhone: '+18015550141', displayPhone: '(801) 555-0141', display: '(801) 555-0141' });
        expect(data.total).toBe(1);
        expect(data.matches[0]).toEqual(expect.objectContaining({
            id: String(ids.single._id), name: 'Avery Single', status: 'New', vehicle: '2021 Toyota Tacoma', assignedTo: 'Casey Morgan', noteCount: 2, closed: false,
        }));
        expect(Object.keys(data.matches[0]).sort()).toEqual(['assignedTo', 'closed', 'createdAt', 'customerRecordId', 'id', 'lastActivity', 'location', 'name', 'noteCount', 'source', 'status', 'vehicle'].sort());
        expect(JSON.stringify(data)).not.toMatch(/Prefers texts|"email"|"phone":/);
        expect(data.organization.name).toBe('Extension Motors');
    });

    it('shows every lead that shares a number separately, never merged', async () => {
        for (const phone of ['801-555-0142', 'tel:+18015550142', '+1 (801) 555-0142']) {
            const res = await ext('post', '/lookup', extToken).send({ phone }).expect(200);
            expect(res.body.data.total).toBe(2);
            expect(res.body.data.matches.map((match: any) => match.id).sort()).toEqual([ids.multiA._id, ids.multiB._id].map(String).sort());
        }
        const res = await ext('post', '/lookup', extToken).send({ phone: '801-555-0142' }).expect(200);
        expect(res.body.data.matches.find((match: any) => match.name === 'Jordan Shared').closed).toBe(true);
    });

    it('returns no match without creating anything, and never shows another dealership\'s lead', async () => {
        const before = await Lead.countDocuments({});
        const none = await ext('post', '/lookup', extToken).send({ phone: '(801) 555-0199' }).expect(200);
        expect(none.body.data.total).toBe(0);
        expect(none.body.data.matches).toEqual([]);
        expect(await Lead.countDocuments({})).toBe(before);
        const other = await ext('post', '/lookup', otherExtToken).send({ phone: '(801) 555-0141' }).expect(200);
        expect(other.body.data.matches.map((match: any) => match.id)).toEqual([String(ids.foreign._id)]);
    });

    it('rejects numbers that are not complete phone numbers', async () => {
        for (const phone of ['555-0141', '2026-10-26', '<script>alert(1)</script>', 'call me', '12345678901234567', '', 42]) {
            await ext('post', '/lookup', extToken).send({ phone }).expect(400);
        }
    });

    it('warns about Do Not Contact and STOP without sending anything', async () => {
        const dnc = await ext('post', '/lookup', extToken).send({ phone: '801-555-0143' }).expect(200);
        expect(dnc.body.data.contact).toEqual({ doNotContact: true, restrictionUnknown: false, textOptOut: false });
        const stop = await ext('post', '/lookup', extToken).send({ phone: '801-555-0144' }).expect(200);
        expect(stop.body.data.contact.textOptOut).toBe(true);
        const clear = await ext('post', '/lookup', extToken).send({ phone: '801-555-0141' }).expect(200);
        expect(clear.body.data.contact).toEqual({ doNotContact: false, restrictionUnknown: false, textOptOut: false });
    });

    it('shows a lead\'s notes newest first, only inside the same dealership', async () => {
        const res = await ext('get', `/leads/${ids.single._id}/notes`, extToken).expect(200);
        expect(res.body.data.notes.map((note: any) => note.text)).toEqual(['Asked about the TRD package', 'Prefers texts after 5 PM']);
        expect(res.body.data.notes[0]).toEqual(expect.objectContaining({ author: 'Casey Morgan', byAi: false, createdAt: new Date(Date.UTC(2026, 9, 22, 18)).toISOString() }));
        await ext('get', `/leads/${ids.foreign._id}/notes`, extToken).expect(404);
        await ext('get', '/leads/not-an-id/notes', extToken).expect(404);
        await ext('get', `/leads/${ids.single._id}/notes`).expect(401);
    });

    it('only allows the extension origin and refuses other websites', async () => {
        const preflight = await request(app).options('/api/crm/extension/lookup').set('Origin', EXT_ORIGIN).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'authorization,content-type');
        expect(preflight.status).toBe(204);
        expect(preflight.headers['access-control-allow-origin']).toBe(EXT_ORIGIN);
        const evilPreflight = await request(app).options('/api/crm/extension/lookup').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST');
        expect(evilPreflight.headers['access-control-allow-origin']).toBeUndefined();
        await request(app).post('/api/crm/extension/lookup').set('Origin', 'https://evil.example').set('Authorization', `Bearer ${extToken}`).send({ phone: '801-555-0141' }).expect(403);
        expect(isAllowedExtensionOrigin(EXT_ORIGIN, '')).toBe(true);
        expect(isAllowedExtensionOrigin(EXT_ORIGIN, 'ponmlkjihgfedcbaponmlkjihgfedcba')).toBe(false);
        expect(isAllowedExtensionOrigin('chrome-extension://short', '')).toBe(false);
    });

    it('limits how many lookups one employee can run per minute', async () => {
        process.env.SKIP_RATE_LIMIT = 'false';
        try {
            const statuses: number[] = [];
            for (let i = 0; i < 32; i += 1) {
                const res = await ext('post', '/lookup', otherExtToken).send({ phone: '801-555-0199' });
                statuses.push(res.status);
            }
            expect(statuses.filter((status) => status === 200).length).toBe(30);
            expect(statuses.slice(-1)[0]).toBe(429);
        } finally {
            process.env.SKIP_RATE_LIMIT = 'true';
        }
    });

    it('stays switched off in production until the extension ID is configured, then accepts only that ID', async () => {
        const prodId = 'fjpfmocfeidcflangiebhbmdkfmbloek';
        const prodOrigin = `chrome-extension://${prodId}`;
        const previousEnv = config.env;
        const previousIds = process.env.CRM_EXTENSION_IDS;
        try {
            (config as any).env = 'production';
            delete process.env.CRM_EXTENSION_IDS;
            const off = await request(app).post('/api/crm/extension/session').set('Origin', prodOrigin).send({ username: otherCrmUser.username, password: PASSWORD }).expect(403);
            expect(off.body.message).toBe('The Suprah CRM extension is not turned on for this server yet');
            await request(app).get('/api/crm/extension/session').set('Authorization', `Bearer ${otherExtToken}`).expect(403);
            process.env.CRM_EXTENSION_IDS = ` ${prodId.toUpperCase()} , not-an-id`;
            await request(app).post('/api/crm/extension/lookup').set('Origin', prodOrigin).set('Authorization', `Bearer ${otherExtToken}`).send({ phone: '801-555-0199' }).expect(200);
            await request(app).get('/api/crm/extension/session').set('Authorization', `Bearer ${otherExtToken}`).expect(200);
            await ext('post', '/lookup', otherExtToken).send({ phone: '801-555-0199' }).expect(403);
            const preflight = await request(app).options('/api/crm/extension/lookup').set('Origin', EXT_ORIGIN).set('Access-Control-Request-Method', 'POST');
            expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
        } finally {
            (config as any).env = previousEnv;
            if (previousIds === undefined) delete process.env.CRM_EXTENSION_IDS;
            else process.env.CRM_EXTENSION_IDS = previousIds;
        }
        expect(parseExtensionIds(` ${prodId.toUpperCase()}, short, ${prodId}`)).toEqual([prodId, prodId]);
        expect(extensionApiEnabled('', true)).toBe(false);
        expect(extensionApiEnabled('', false)).toBe(true);
        expect(isAllowedExtensionOrigin(undefined, '', true)).toBe(false);
        expect(isAllowedExtensionOrigin(undefined, prodId, true)).toBe(true);
        expect(isAllowedExtensionOrigin(prodOrigin, prodId, true)).toBe(true);
        expect(isAllowedExtensionOrigin(EXT_ORIGIN, prodId, true)).toBe(false);
    });

    it('limits failed extension sign-ins without counting successful ones or touching CRM web login', async () => {
        process.env.SKIP_RATE_LIMIT = 'false';
        try {
            for (let i = 0; i < 6; i += 1) {
                await ext('post', '/session').send({ username: otherCrmUser.username, password: PASSWORD }).expect(200);
            }
            const statuses: number[] = [];
            for (let i = 0; i < 6; i += 1) {
                const res = await ext('post', '/session').send({ username: `NOBODY-${stamp}`, password: 'wrong-password' });
                statuses.push(res.status);
            }
            expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
            expect(statuses[5]).toBe(429);
            await request(app).post('/api/crm/login').send({ username: otherCrmUser.username, password: PASSWORD }).expect(200);
            await ext('post', '/session').send({ username: otherCrmUser.username, password: PASSWORD }).expect(200);
        } finally {
            process.env.SKIP_RATE_LIMIT = 'true';
        }
    });

    it('leaves CRM web login working exactly as before', async () => {
        const ok = await request(app).post('/api/crm/login').send({ username: crmUser.username, password: PASSWORD }).expect(200);
        expect(jwt.decode(ok.body.data.token)).toEqual(expect.objectContaining({ type: 'crm', id: String(crmUser._id) }));
        expect(ok.body.data.user.fullName).toBe('Taylor Lookup');
        const wrong = await request(app).post('/api/crm/login').send({ username: crmUser.username, password: 'nope' }).expect(401);
        expect(wrong.body.message).toBe('Invalid Employee ID or password');
        const off = await request(app).post('/api/crm/login').send({ username: inactiveUser.username, password: PASSWORD }).expect(403);
        expect(off.body.message).toBe('Account has been deactivated. Contact your administrator.');
        const missing = await request(app).post('/api/crm/login').send({ username: crmUser.username }).expect(400);
        expect(missing.body.message).toBe('Employee ID and password are required');
    });

    it('never lets request headers stand in for a valid extension sign-in', async () => {
        const body = { phone: '801-555-0141' };
        const noToken = await request(app).post('/api/crm/extension/lookup').set('Origin', EXT_ORIGIN).send(body).expect(401);
        expect(noToken.body.message).toBe('Please sign in to Suprah CRM');
        await request(app).post('/api/crm/extension/lookup').send(body).expect(401);
        await request(app).get(`/api/crm/extension/leads/${ids.single}/notes`).expect(401);
        await request(app).get('/api/crm/extension/session').set('Origin', EXT_ORIGIN).set('X-Forwarded-For', '10.0.0.1').expect(401);
        const wrongSecret = jwt.sign({ id: String(crmUser._id), type: 'crm_ext', sid: String(new mongoose.Types.ObjectId()) }, 'not-the-server-secret', { expiresIn: '1h' });
        await request(app).post('/api/crm/extension/lookup').set('Origin', EXT_ORIGIN).set('Authorization', `Bearer ${wrongSecret}`).send(body).expect(401);
        const noSession = jwt.sign({ id: String(crmUser._id), type: 'crm_ext', sid: String(new mongoose.Types.ObjectId()) }, CRM_JWT_SECRET, { expiresIn: '1h' });
        await request(app).post('/api/crm/extension/lookup').set('Origin', EXT_ORIGIN).set('Authorization', `Bearer ${noSession}`).send(body).expect(401);
        await request(app).post('/api/crm/extension/lookup').set('Authorization', `Bearer ${noSession}`).send(body).expect(401);
    });

    it('cuts off an employee on the next request once they are deactivated or offboarded', async () => {
        const temp = await CrmUser.create({ organizationId: org._id, fullName: 'Leaving Rep', username: `EXT-LEAVE-${stamp}`, email: `ext-leave-${stamp}@example.com`, password: PASSWORD, role: 'employee', isActive: true });
        try {
            const signIn = await ext('post', '/session').send({ username: temp.username, password: PASSWORD }).expect(200);
            const token = signIn.body.data.token;
            await ext('post', '/lookup', token).send({ phone: '801-555-0141' }).expect(200);
            await CrmUser.updateOne({ _id: temp._id }, { $set: { isActive: false, isOffboarded: true, offboardedAt: new Date() } });
            const blocked = await ext('post', '/lookup', token).send({ phone: '801-555-0141' }).expect(403);
            expect(blocked.body.message).toBe('Your Suprah CRM account is not active');
            await ext('get', `/leads/${ids.single}/notes`, token).expect(403);
            await ext('post', '/session').send({ username: temp.username, password: PASSWORD }).expect(403);
        } finally {
            await Session.deleteMany({ crmUserId: temp._id });
            await CrmUser.deleteOne({ _id: temp._id });
        }
    });

    it('ends the session on sign-out and after expiry', async () => {
        await ext('delete', '/session', extToken).expect(200);
        await ext('post', '/lookup', extToken).send({ phone: '801-555-0141' }).expect(401);
        await Session.updateMany({ refreshTokenHash: authTokenHash(otherExtToken) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
        await ext('get', '/session', otherExtToken).expect(401);
    });
});
