import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import tokenService from '../src/services/token.service';

const stamp = Date.now();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000);

describe('Lead Inbox latest activity order (real database)', () => {
    let org: any;
    let otherOrg: any;
    let admin: any;
    let token: string;
    const tag = `Activitytest${stamp}`;

    const leadDoc = (doc: Record<string, unknown>) => ({
        organizationId: org._id,
        createdBy: admin._id,
        channel: 'sms',
        source: 'Inbound SMS',
        status: 'New',
        lastName: tag,
        ...doc,
    });

    beforeAll(async () => {
        if (mongoose.connection.readyState !== 1) await mongoose.connection.asPromise();
        org = await Organization.create({ name: 'Activity Org', slug: `activity-${stamp}`, status: 'active' });
        otherOrg = await Organization.create({ name: 'Activity Other Org', slug: `activity-other-${stamp}`, status: 'active' });
        admin = await User.create({
            email: `activity-admin-${stamp}@example.com`, password: 'Password123!', name: 'Activity Admin', role: 'admin',
            organizationId: org._id, organizationRole: 'admin', emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        token = tokenService.generateAccessToken(admin);

        await Lead.create(leadDoc({ firstName: 'Oldtexter', email: `a1.${stamp}@example.com`, createdAt: hoursAgo(100), followUp: { lastCustomerActivityAt: hoursAgo(1) } }));
        await Lead.create(leadDoc({ firstName: 'Freshlead', email: `a2.${stamp}@example.com`, createdAt: hoursAgo(2), followUp: { lastCustomerActivityAt: hoursAgo(2) } }));
        await Lead.create(leadDoc({ firstName: 'Middle', email: `a3.${stamp}@example.com`, createdAt: hoursAgo(50), followUp: { lastCustomerActivityAt: hoursAgo(10), lastRepResponseAt: hoursAgo(0.5) } }));
        await Lead.create(leadDoc({ firstName: 'Quiet', email: `a4.${stamp}@example.com`, createdAt: hoursAgo(5), followUp: { lastCustomerActivityAt: hoursAgo(6) } }));
        await Lead.create({
            organizationId: otherOrg._id, createdBy: admin._id, channel: 'sms', source: 'Inbound SMS', status: 'New',
            firstName: 'Foreign', lastName: tag, email: `a5.${stamp}@example.com`, followUp: { lastCustomerActivityAt: new Date() },
        });
    });

    afterAll(async () => {
        const orgIds = [org._id, otherOrg._id];
        await Lead.deleteMany({ organizationId: { $in: orgIds } });
        await User.deleteMany({ _id: admin._id });
        await Organization.deleteMany({ _id: { $in: orgIds } });
    });

    const get = (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`);
    const names = (res: any) => res.body.data.leads.map((lead: any) => lead.firstName);

    it('puts the lead whose customer wrote most recently first, even if the lead is old', async () => {
        const res = await get(`/api/leads?sortBy=latest_activity&search=${tag}`).expect(200);
        expect(names(res)).toEqual(['Oldtexter', 'Freshlead', 'Quiet', 'Middle']);
        expect(res.body.data.total).toBe(4);
    });

    it('moves a lead to the top as soon as the customer sends a new message', async () => {
        await Lead.updateOne({ organizationId: org._id, firstName: 'Middle', lastName: tag }, { $set: { 'followUp.lastCustomerActivityAt': new Date() } });
        const res = await get(`/api/leads?sortBy=latest_activity&search=${tag}`).expect(200);
        expect(names(res)[0]).toBe('Middle');
        await Lead.updateOne({ organizationId: org._id, firstName: 'Middle', lastName: tag }, { $set: { 'followUp.lastCustomerActivityAt': hoursAgo(10) } });
    });

    it('pages through the same order without repeats', async () => {
        const one = await get(`/api/leads?sortBy=latest_activity&search=${tag}&limit=2&page=1`).expect(200);
        const two = await get(`/api/leads?sortBy=latest_activity&search=${tag}&limit=2&page=2`).expect(200);
        expect([...names(one), ...names(two)]).toEqual(['Oldtexter', 'Freshlead', 'Quiet', 'Middle']);
        expect(two.body.data.pages).toBe(2);
    });

    it('returns the same list fields as the other sorts', async () => {
        const res = await get(`/api/leads?sortBy=latest_activity&search=${tag}&limit=1`).expect(200);
        const lead = res.body.data.leads[0];
        expect(lead.email).toBe(`a1.${stamp}@example.com`);
        expect(new Date(lead.followUp.lastCustomerActivityAt).getTime()).toBeGreaterThan(Date.now() - 2 * 3600_000);
        expect(lead.body).toBeUndefined();
        expect(lead.activityAt).toBeUndefined();
    });

    it('keeps Newest sorted by the day the lead came in', async () => {
        const res = await get(`/api/leads?sortBy=newest&search=${tag}`).expect(200);
        expect(names(res)).toEqual(['Freshlead', 'Quiet', 'Middle', 'Oldtexter']);
    });

    it('never shows another dealership in the list', async () => {
        const res = await get(`/api/leads?sortBy=latest_activity&search=${tag}`).expect(200);
        expect(names(res)).not.toContain('Foreign');
    });
});
