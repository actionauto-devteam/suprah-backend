import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Organization from '../src/models/Organization.model';
import Session from '../src/models/Session.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';
import { issueCrmSessionToken } from '../src/middleware/crmAuth.middleware';
import { cleanHistoryText } from '../src/services/crmExtension.service';

const stamp = Date.now();
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const PASSWORD = 'ExtPass!2026';

describe('Suprah CRM extension side panel: history, notes, email lookup and AI status (real database)', () => {
    let org: any;
    let otherOrg: any;
    let mainAdmin: any;
    let crmUser: any;
    let otherCrmUser: any;
    let token = '';
    let otherToken = '';
    const ids: Record<string, any> = {};
    const previousAiSwitch = process.env.AI_AGENT_ENABLED;

    const createLead = (orgId: unknown, doc: Record<string, unknown>) => Lead.create({
        organizationId: orgId,
        createdBy: mainAdmin._id,
        channel: 'sms',
        source: 'Inbound SMS',
        status: 'New',
        ...doc,
    });

    const ext = (method: 'get' | 'post', path: string, auth = token) => request(app)[method](`/api/crm/extension${path}`)
        .set('Origin', EXT_ORIGIN)
        .set('Authorization', `Bearer ${auth}`);

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
        org = await Organization.create({ name: 'Panel Motors', slug: `panel-${stamp}`, status: 'active' });
        otherOrg = await Organization.create({ name: 'Other Panel Motors', slug: `panel-other-${stamp}`, status: 'active' });
        mainAdmin = await User.create({
            email: `panel-admin-${stamp}@example.com`, password: 'Password123!', name: 'Panel Admin', role: 'admin',
            organizationId: org._id, organizationRole: 'admin', emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        crmUser = await CrmUser.create({ organizationId: org._id, fullName: 'Riley Panel', username: `PANEL-${stamp}`, email: `panel-crm-${stamp}@example.com`, password: PASSWORD, role: 'employee', isActive: true });
        otherCrmUser = await CrmUser.create({ organizationId: otherOrg._id, fullName: 'Other Panel', username: `PANEL-OTHER-${stamp}`, email: `panel-other-${stamp}@example.com`, password: PASSWORD, role: 'employee', isActive: true });

        ids.sms = await createLead(org._id, { firstName: 'Avery', lastName: 'History', phone: '(801) 555-0161', email: `avery.history.${stamp}@example.com` });
        ids.emailOnly = await createLead(org._id, { firstName: 'Jordan', lastName: 'Inbox', phone: '', email: `Jordan.Inbox.${stamp}@Example.com`, channel: 'email', source: 'Email Inquiry' });
        ids.noContact = await createLead(org._id, { firstName: 'Quiet', lastName: 'Lead', phone: '', channel: 'web', source: 'Website Inquiry' });
        ids.proxy = await createLead(org._id, { firstName: 'Proxy', lastName: 'Lead', phone: '', email: `proxy.${stamp}@example.com`, identityEmailExcluded: true, channel: 'adf', source: 'Third-Party Lead' });
        ids.dncEmail = await createLead(org._id, { firstName: 'Dana', lastName: 'Restricted', phone: '', email: `dana.${stamp}@example.com`, channel: 'email', status: 'Do Not Contact' });
        ids.markup = await createLead(org._id, { firstName: 'Markup', lastName: 'Lead', phone: '(801) 555-0168', channel: 'adf', source: 'Third-Party Lead', parsedContent: '<?xml version="1.0"?><adf><prospect><customer><contact><name part="full">Markup Lead</name></contact><comments>Is the &quot;Tacoma&quot; still available?</comments></customer></prospect></adf>' });
        ids.foreign = await createLead(otherOrg._id, { firstName: 'Foreign', lastName: 'Lead', phone: '(801) 555-0161', email: `avery.history.${stamp}@example.com` });

        const start = Date.UTC(2026, 9, 20, 15);
        await Lead.collection.updateOne({ _id: ids.sms._id }, { $set: { createdAt: new Date(start - 86400000) } });
        const conversation = await Conversation.create({ orgId: String(org._id), customerPhone: '+18015550161', leadId: ids.sms._id, lastMessageAt: new Date() });
        ids.conversation = conversation;
        const messages = [];
        for (let i = 0; i < 24; i += 1) {
            const inbound = i % 2 === 0;
            messages.push({
                orgId: String(org._id),
                conversationId: conversation._id,
                leadId: ids.sms._id,
                direction: inbound ? 'inbound' : 'outbound',
                body: inbound ? `Customer message ${i}` : `Team reply ${i}`,
                from: inbound ? '+18015550161' : '+18015550100',
                to: inbound ? '+18015550100' : '+18015550161',
                status: inbound ? 'received' : (i === 23 ? 'failed' : 'delivered'),
                sentBy: inbound ? null : { userId: 'staff', name: 'Casey Morgan' },
                createdAt: new Date(start + i * 60000),
                updatedAt: new Date(start + i * 60000),
            });
        }
        await CommunicationMessage.collection.insertMany(messages);

        const signIn = await request(app).post('/api/crm/extension/session').set('Origin', EXT_ORIGIN).send({ username: crmUser.username, password: PASSWORD }).expect(200);
        token = signIn.body.data.token;
        const otherSignIn = await request(app).post('/api/crm/extension/session').set('Origin', EXT_ORIGIN).send({ username: otherCrmUser.username, password: PASSWORD }).expect(200);
        otherToken = otherSignIn.body.data.token;
    });

    afterAll(async () => {
        if (previousAiSwitch === undefined) delete process.env.AI_AGENT_ENABLED;
        else process.env.AI_AGENT_ENABLED = previousAiSwitch;
        const orgIds = [org._id, otherOrg._id];
        await CommunicationMessage.deleteMany({ orgId: { $in: [...orgIds, ...orgIds.map(String)] } });
        await Conversation.deleteMany({ orgId: { $in: [...orgIds, ...orgIds.map(String)] } });
        await Lead.deleteMany({ organizationId: { $in: orgIds } });
        await Customer.deleteMany({ organizationId: { $in: orgIds.map(String) } });
        await Session.deleteMany({ crmUserId: { $in: [crmUser._id, otherCrmUser._id] } });
        await CrmUser.deleteMany({ _id: { $in: [crmUser._id, otherCrmUser._id] } });
        await User.deleteMany({ organizationId: { $in: orgIds } });
        await Organization.deleteMany({ _id: { $in: orgIds } });
    });

    it('looks up leads by an exact email address inside the dealership only', async () => {
        const res = await ext('post', '/lookup').send({ email: `  Jordan.Inbox.${stamp}@EXAMPLE.com ` }).expect(200);
        expect(res.body.data.query).toEqual({ kind: 'email', normalizedEmail: `jordan.inbox.${stamp}@example.com`, display: `jordan.inbox.${stamp}@example.com` });
        expect(res.body.data.matches.map((m: any) => m.id)).toEqual([String(ids.emailOnly._id)]);
        expect(res.body.data.contact).toEqual({ doNotContact: false, restrictionUnknown: false, textOptOut: false });

        const fromLink = await ext('post', '/lookup').send({ email: `mailto:jordan.inbox.${stamp}@example.com?subject=Hello` }).expect(200);
        expect(fromLink.body.data.total).toBe(1);

        const shared = await ext('post', '/lookup').send({ email: `avery.history.${stamp}@example.com` }).expect(200);
        expect(shared.body.data.matches.map((m: any) => m.id)).toEqual([String(ids.sms._id)]);
        const otherSide = await ext('post', '/lookup', otherToken).send({ email: `avery.history.${stamp}@example.com` }).expect(200);
        expect(otherSide.body.data.matches.map((m: any) => m.id)).toEqual([String(ids.foreign._id)]);

        const proxy = await ext('post', '/lookup').send({ email: `proxy.${stamp}@example.com` }).expect(200);
        expect(proxy.body.data.total).toBe(0);

        const dnc = await ext('post', '/lookup').send({ email: `dana.${stamp}@example.com` }).expect(200);
        expect(dnc.body.data.contact.doNotContact).toBe(true);

        const invalid = await ext('post', '/lookup').send({ email: 'not-an-email' }).expect(400);
        expect(invalid.body.message).toBe("That doesn't look like a complete email address");
        await ext('post', '/lookup').send({ email: `jordan.inbox.${stamp}@example.com`, phone: '801-555-0161' }).expect(400);
        await ext('post', '/lookup').send({ email: { $ne: null } }).expect(400);
        expect(await Lead.countDocuments({ organizationId: org._id })).toBe(6);
    });

    it('refuses email lookups that are not exactly one complete address, and matches real addresses with an apostrophe', async () => {
        for (const email of ['mailto:a@example.com,b@example.com', 'a@example.com b@example.com', 'a@example.com;b@example.com', '<script>@example.com', 'not-an-email', `${'x'.repeat(250)}@example.com`, 'jordan..inbox@example.com', '.jordan@example.com', 'jordan@example']) {
            await ext('post', '/lookup').send({ email }).expect(400);
        }
        const kerry = await createLead(org._id, { firstName: 'Kerry', lastName: "O'Brien", phone: '', email: `Kerry.O'Brien.${stamp}@Example.com`, channel: 'email', source: 'Email Inquiry' });
        const res = await ext('post', '/lookup').send({ email: `kerry.o'brien.${stamp}@example.com` }).expect(200);
        expect(res.body.data.matches.map((m: any) => m.id)).toEqual([String(kerry._id)]);
        const other = await ext('post', '/lookup', otherToken).send({ email: `kerry.o'brien.${stamp}@example.com` }).expect(200);
        expect(other.body.data.total).toBe(0);
    });

    it('shows the conversation history from the CRM timeline, newest first, in pages', async () => {
        const first = await ext('get', `/leads/${ids.sms._id}/history`).expect(200);
        const page1 = first.body.data;
        expect(page1.items).toHaveLength(20);
        expect(page1.hasMore).toBe(true);
        expect(typeof page1.nextCursor).toBe('string');
        expect(page1.items[0]).toEqual(expect.objectContaining({ channel: 'sms', direction: 'outbound', title: 'Text sent', body: 'Team reply 23', status: 'failed', actor: 'Casey Morgan' }));
        expect(Object.keys(page1.items[0]).sort()).toEqual(['actor', 'body', 'channel', 'direction', 'id', 'occurredAt', 'status', 'title'].sort());
        const times = page1.items.map((item: any) => new Date(item.occurredAt).getTime());
        expect([...times].sort((a, b) => b - a)).toEqual(times);

        const second = await ext('get', `/leads/${ids.sms._id}/history?before=${encodeURIComponent(page1.nextCursor)}`).expect(200);
        const page2 = second.body.data;
        const firstIds = new Set(page1.items.map((item: any) => item.id));
        expect(page2.items.length).toBeGreaterThan(0);
        expect(page2.items.some((item: any) => firstIds.has(item.id))).toBe(false);
        expect(page2.items.some((item: any) => item.title.startsWith('Lead received'))).toBe(true);

        await ext('get', `/leads/${ids.sms._id}/history?before=${encodeURIComponent('<script>')}`).expect(400);
        await ext('get', `/leads/${ids.sms._id}/history?before=${'a'.repeat(301)}`).expect(400);
    });

    it('turns raw markup in history into short plain text', async () => {
        const res = await ext('get', `/leads/${ids.markup._id}/history`).expect(200);
        const received = res.body.data.items.find((item: any) => item.title.startsWith('Lead received'));
        expect(received.body).toBe('Markup Lead Is the "Tacoma" still available?');
        expect(cleanHistoryText('a'.repeat(700))).toHaveLength(600);
        expect(cleanHistoryText('Love it <3 see you > 5pm')).toBe('Love it <3 see you > 5pm');
        expect(cleanHistoryText(null)).toBe('');
    });

    it('never shows another dealership\'s history, notes or AI status', async () => {
        await ext('get', `/leads/${ids.foreign._id}/history`).expect(404);
        await ext('get', `/leads/${ids.foreign._id}/ai-status`).expect(404);
        await ext('post', `/leads/${ids.foreign._id}/notes`).send({ note: 'Should never be saved' }).expect(404);
        await ext('get', `/leads/${ids.sms._id}/history`, otherToken).expect(404);
        await ext('get', `/leads/not-an-id/history`).expect(404);
        const foreign: any = await Lead.findById(ids.foreign._id).select('notes').lean();
        expect(foreign.notes || []).toHaveLength(0);
    });

    it('adds plain-text notes through the CRM note service, once per click', async () => {
        const created = await ext('post', `/leads/${ids.sms._id}/notes`).send({ note: '  Called back, prefers mornings. <b>VIP</b>  ' }).expect(201);
        expect(created.body.data.duplicate).toBe(false);
        expect(created.body.data.note).toEqual(expect.objectContaining({ text: 'Called back, prefers mornings. <b>VIP</b>', author: 'Riley Panel', byAi: false }));

        const again = await ext('post', `/leads/${ids.sms._id}/notes`).send({ note: 'Called back, prefers mornings. <b>VIP</b>' }).expect(200);
        expect(again.body.data.duplicate).toBe(true);

        const lead: any = await Lead.findById(ids.sms._id).select('notes').lean();
        expect(lead.notes).toHaveLength(1);
        expect(lead.notes[0]).toEqual(expect.objectContaining({ text: 'Called back, prefers mornings. <b>VIP</b>', authorType: 'user', authorName: 'Riley Panel' }));
        expect(String(lead.notes[0].createdBy)).toBe(String(crmUser._id));
        expect(lead.notes[0].mentionedUserIds || []).toHaveLength(0);

        const listed = await ext('get', `/leads/${ids.sms._id}/notes`).expect(200);
        expect(listed.body.data.notes[0].text).toBe('Called back, prefers mornings. <b>VIP</b>');

        expect((await ext('post', `/leads/${ids.sms._id}/notes`).send({ note: '   ' }).expect(400)).body.message).toBe('Write a note before saving.');
        await ext('post', `/leads/${ids.sms._id}/notes`).send({ note: ['a', 'b'] }).expect(400);
        await ext('post', `/leads/${ids.sms._id}/notes`).send({}).expect(400);
        expect((await ext('post', `/leads/${ids.sms._id}/notes`).send({ note: 'x'.repeat(5001) }).expect(400)).body.message).toBe('Note cannot exceed 5000 characters');
        const after: any = await Lead.findById(ids.sms._id).select('notes').lean();
        expect(after.notes).toHaveLength(1);
    });

    it('reports the AI Agent status read-only, the same way the CRM shows it', async () => {
        process.env.AI_AGENT_ENABLED = 'true';
        await Organization.updateOne({ _id: org._id }, { $set: { 'metadata.aiAgentModes': { sms: 'live', email: 'training', webchat: 'off' } } });

        const live = await ext('get', `/leads/${ids.sms._id}/ai-status`).expect(200);
        const agentName = live.body.data.agentName;
        expect(live.body.data).toEqual(expect.objectContaining({ channel: 'sms', channelLabel: 'Text messages', mode: 'live', state: 'live', label: `${agentName} live` }));

        const until = new Date(Date.now() + 20 * 60000);
        await Conversation.updateOne({ _id: ids.conversation._id }, { $set: { aiAutoPausedUntil: until } });
        const auto = await ext('get', `/leads/${ids.sms._id}/ai-status`).expect(200);
        expect(auto.body.data).toEqual(expect.objectContaining({ state: 'auto_paused', label: 'Auto-paused', autoPausedUntil: until.toISOString() }));

        await Conversation.updateOne({ _id: ids.conversation._id }, { $set: { aiPausedAt: new Date(), aiPausedBy: { userId: 'staff', name: 'Casey Morgan' } } });
        const paused = await ext('get', `/leads/${ids.sms._id}/ai-status`).expect(200);
        expect(paused.body.data).toEqual(expect.objectContaining({ state: 'paused', label: 'Paused by Casey Morgan', pausedBy: 'Casey Morgan', autoPausedUntil: null }));

        const email = await ext('get', `/leads/${ids.emailOnly._id}/ai-status`).expect(200);
        expect(email.body.data).toEqual(expect.objectContaining({ channel: 'email', channelLabel: 'Email replies', mode: 'training', state: 'training', label: `${agentName}: Training — not sending` }));

        const none = await ext('get', `/leads/${ids.noContact._id}/ai-status`).expect(200);
        expect(none.body.data).toEqual(expect.objectContaining({ channel: null, state: 'none' }));

        process.env.AI_AGENT_ENABLED = 'false';
        const switchedOff = await ext('get', `/leads/${ids.sms._id}/ai-status`).expect(200);
        expect(switchedOff.body.data).toEqual(expect.objectContaining({ mode: 'off', state: 'off', label: `${agentName}: Off — not sending` }));

        const conversation: any = await Conversation.findById(ids.conversation._id).lean();
        expect(conversation.aiPausedBy.name).toBe('Casey Morgan');
        expect(new Date(conversation.aiAutoPausedUntil).toISOString()).toBe(until.toISOString());
    });

    it('needs a valid extension sign-in for every new panel request', async () => {
        const crmToken = await issueCrmSessionToken(String(crmUser._id));
        for (const path of [`/leads/${ids.sms._id}/history`, `/leads/${ids.sms._id}/ai-status`]) {
            await request(app).get(`/api/crm/extension${path}`).set('Origin', EXT_ORIGIN).expect(401);
            await ext('get', path, crmToken).expect(401);
            await request(app).get(`/api/crm/extension${path}`).set('Origin', 'https://evil.example').set('Authorization', `Bearer ${token}`).expect(403);
        }
        await request(app).post(`/api/crm/extension/leads/${ids.sms._id}/notes`).set('Origin', EXT_ORIGIN).send({ note: 'No sign-in' }).expect(401);
        await ext('post', `/leads/${ids.sms._id}/notes`, crmToken).send({ note: 'CRM web token' }).expect(401);
        await request(app).post(`/api/crm/extension/leads/${ids.sms._id}/notes`).set('Origin', 'https://evil.example').set('Authorization', `Bearer ${token}`).send({ note: 'Other website' }).expect(403);
        const lead: any = await Lead.findById(ids.sms._id).select('notes').lean();
        expect(lead.notes.some((note: any) => /No sign-in|CRM web token|Other website/.test(note.text))).toBe(false);
    });

    it('limits how many notes one employee can add per minute', async () => {
        process.env.SKIP_RATE_LIMIT = 'false';
        try {
            const statuses: number[] = [];
            for (let i = 0; i < 11; i += 1) {
                const res = await ext('post', `/leads/${ids.emailOnly._id}/notes`).send({ note: `Rate limit note ${i}` });
                statuses.push(res.status);
            }
            expect(statuses.filter((status) => status === 201)).toHaveLength(10);
            expect(statuses[10]).toBe(429);
        } finally {
            process.env.SKIP_RATE_LIMIT = 'true';
        }
    });
});
