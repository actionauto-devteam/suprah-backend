import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import Appointment from '../src/models/Appointment.model';
import { CallLog, CommunicationMessage, Conversation } from '../src/models/communication.model';
import tokenService from '../src/services/token.service';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';

const stamp = Date.now();
const mail = (name: string) => `${name}.${stamp}@example.com`;

describe('Customer Records (real database)', () => {
    let org: any;
    let otherOrg: any;
    let admin: any;
    let portalCustomer: any;
    let token: string;
    let portalToken: string;
    const ids: Record<string, any> = {};

    const createLead = (doc: Record<string, unknown>) => Lead.create({
        organizationId: org._id,
        createdBy: admin._id,
        channel: 'sms',
        source: 'Inbound SMS',
        status: 'New',
        ...doc,
    });

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
        org = await Organization.create({ name: 'Records Org', slug: `records-${stamp}`, status: 'active' });
        otherOrg = await Organization.create({ name: 'Records Other Org', slug: `records-other-${stamp}`, status: 'active' });
        admin = await User.create({
            email: `records-admin-${stamp}@example.com`, password: 'Password123!', name: 'Records Admin', role: 'admin',
            organizationId: org._id, organizationRole: 'admin', emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        portalCustomer = await User.create({
            email: `records-portal-${stamp}@example.com`, password: 'Password123!', name: 'Portal Customer', role: 'customer',
            organizationId: org._id, emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        token = tokenService.generateAccessToken(admin);
        portalToken = tokenService.generateAccessToken(portalCustomer);

        ids.single = await createLead({ firstName: 'Morgan', lastName: 'Single', email: mail('morgan'), vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma' } });
        ids.multiA = await createLead({ firstName: 'Jordan', lastName: 'Sample', email: mail('jordan.a'), phone: '+18015550171', vehicle: { year: '2022', make: 'Honda', model: 'CR-V', vin: '2HKRW2H8XNH600001' } });
        ids.multiB = await createLead({ firstName: 'Jordan', lastName: 'Sample', email: mail('jordan.a'), status: 'Sold', vehicle: { year: '2019', make: 'Subaru', model: 'Outback' } });
        ids.multiC = await createLead({ firstName: 'Jordan', lastName: 'Sample', phone: '(801) 555-0171', status: 'Contacted' });
        ids.twin = await createLead({ firstName: 'Jordan', lastName: 'Sample', email: mail('jordan.b'), phone: '+18015550172' });
        ids.conflict = await createLead({ firstName: 'Jordan', lastName: 'Sample', email: mail('jordan.a'), phone: '+18015550172' });
        ids.webchat = await createLead({ firstName: 'Jordan', lastName: 'Sample', email: mail('jordan.a'), channel: 'webchat', source: 'Website Chat', intakeIdentity: 'unverified' });

        ids.customerA = await Customer.findOne({ organizationId: String(org._id), normalizedEmail: mail('jordan.a') }).lean();
        ids.customerB = await Customer.findOne({ organizationId: String(org._id), normalizedEmail: mail('jordan.b') }).lean();
        ids.customerSingle = await Customer.findOne({ organizationId: String(org._id), normalizedEmail: mail('morgan') }).lean();
        ids.manual = await Customer.create({ organizationId: String(org._id), createdBy: admin._id, firstName: 'Riley', lastName: 'Manual', phone: '+18015550173', source: 'manual' });
        ids.foreign = await Customer.create({ organizationId: String(otherOrg._id), createdBy: admin._id, firstName: 'Jordan', lastName: 'Sample', email: mail('foreign'), source: 'manual' });
        ids.stale = await Lead.collection.insertOne({
            organizationId: org._id, createdBy: admin._id, firstName: 'Stale', lastName: 'Pending', email: mail('stale'), status: 'New', channel: 'email', source: 'Email Inquiry',
            customerId: ids.customerA._id, customerLink: { status: 'pending' }, createdAt: new Date(), updatedAt: new Date(),
        });

        const now = Date.now();
        await Appointment.create([
            { organizationId: String(org._id), createdBy: admin._id, participants: [admin._id], title: 'Test drive CR-V', type: 'test-drive', entryType: 'appointment', status: 'scheduled', startTime: new Date(now + 86400000), endTime: new Date(now + 90000000), leadId: ids.multiA._id },
            { organizationId: String(org._id), createdBy: admin._id, participants: [admin._id], title: 'Delivery Outback', type: 'other', entryType: 'appointment', status: 'completed', startTime: new Date(now - 86400000), endTime: new Date(now - 82800000), leadId: ids.multiB._id },
            { organizationId: String(org._id), createdBy: admin._id, participants: [admin._id], title: 'Unlinked visit', type: 'other', entryType: 'appointment', status: 'scheduled', startTime: new Date(now + 3600000), endTime: new Date(now + 7200000), leadId: ids.webchat._id },
        ]);
        const conversation = await Conversation.create({ orgId: String(org._id), customerPhone: '+18015550171', leadId: ids.multiA._id, lastMessageAt: new Date(), messageCount: 3 });
        await CommunicationMessage.create([
            { orgId: String(org._id), conversationId: conversation._id, leadId: ids.multiA._id, direction: 'inbound', channel: 'sms', from: '+18015550171', to: '+18015550000', body: 'Is it there?', status: 'received' },
            { orgId: String(org._id), conversationId: conversation._id, leadId: ids.multiA._id, direction: 'outbound', channel: 'sms', from: '+18015550000', to: '+18015550171', body: 'Yes', status: 'delivered' },
            { orgId: String(org._id), conversationId: conversation._id, leadId: ids.webchat._id, direction: 'inbound', channel: 'sms', from: '+18015550171', to: '+18015550000', body: 'Unlinked', status: 'received' },
            { orgId: String(org._id), conversationId: conversation._id, leadId: ids.multiA._id, direction: 'inbound', from: '+18015550171', to: '+18015550000', body: 'Copied web inquiry', status: 'received', origin: 'inquiry' },
        ]);
        await CallLog.create({ orgId: String(org._id), leadId: ids.multiA._id, conversationId: conversation._id, direction: 'inbound', from: '+18015550171', to: '+18015550000', status: 'completed', providerCallControlId: `records-${stamp}` });
    });

    afterAll(async () => {
        const orgIds = [org._id, otherOrg._id];
        await CallLog.deleteMany({ orgId: { $in: orgIds.map(String) } });
        await CommunicationMessage.deleteMany({ orgId: { $in: orgIds.map(String) } });
        await Conversation.deleteMany({ orgId: { $in: orgIds.map(String) } });
        await Appointment.deleteMany({ organizationId: { $in: orgIds.map(String) } });
        await Lead.deleteMany({ organizationId: { $in: orgIds } });
        await Customer.deleteMany({ organizationId: { $in: orgIds.map(String) } });
        await User.deleteMany({ _id: { $in: [admin._id, portalCustomer._id] } });
        await Organization.deleteMany({ _id: { $in: orgIds } });
    });

    const list = (query = '') => request(app).get(`/api/crm/customer-records${query}`).set('Authorization', `Bearer ${token}`);
    const profile = (id: unknown) => request(app).get(`/api/crm/customer-records/${id}`).set('Authorization', `Bearer ${token}`);

    it('links leads only through the identity service (exact email or phone)', async () => {
        const reloaded = await Lead.find({ _id: { $in: [ids.multiA._id, ids.multiB._id, ids.multiC._id] } }).lean();
        expect(reloaded.every((lead: any) => lead.customerLink?.status === 'linked' && String(lead.customerId) === String(ids.customerA._id))).toBe(true);
        expect(String((await Lead.findById(ids.twin._id).lean() as any).customerId)).toBe(String(ids.customerB._id));
    });

    it('shows a customer with one linked lead', async () => {
        const res = await profile(ids.customerSingle._id).expect(200);
        expect(res.body.data.relatedLeads).toHaveLength(1);
        expect(res.body.data.summary.leads).toEqual({ total: 1, open: 1, closed: 0 });
    });

    it('shows multiple linked leads split into open and closed', async () => {
        const res = await profile(ids.customerA._id).expect(200);
        const leadIds = res.body.data.relatedLeads.map((lead: any) => lead.id).sort();
        expect(leadIds).toEqual([ids.multiA._id, ids.multiB._id, ids.multiC._id].map(String).sort());
        expect(res.body.data.summary.leads).toEqual({ total: 3, open: 2, closed: 1 });
    });

    it('shows a customer with no linked leads honestly', async () => {
        const res = await profile(ids.manual._id).expect(200);
        expect(res.body.data.relatedLeads).toEqual([]);
        expect(res.body.data.summary.leads.total).toBe(0);
        expect(res.body.data.summary.lastActivity).toBeNull();
    });

    it('keeps different customers with the same name separate', async () => {
        const res = await list('?search=Jordan%20Sample').expect(200);
        const found = res.body.data.customers.map((customer: any) => customer.id);
        expect(found).toEqual(expect.arrayContaining([String(ids.customerA._id), String(ids.customerB._id)]));
        expect(found).not.toContain(String(ids.foreign._id));
        const b = await profile(ids.customerB._id).expect(200);
        expect(b.body.data.relatedLeads.map((lead: any) => lead.id)).toEqual([String(ids.twin._id)]);
    });

    it('leaves a lead with conflicting email and phone unlinked and flags it for review', async () => {
        const conflict: any = await Lead.findById(ids.conflict._id).lean();
        expect(conflict.customerId).toBeUndefined();
        expect(['ambiguous', 'conflict']).toContain(conflict.customerLink.status);
        const a = await profile(ids.customerA._id).expect(200);
        expect(a.body.data.relatedLeads.map((lead: any) => lead.id)).not.toContain(String(ids.conflict._id));
        expect(a.body.data.summary.leadsNeedingReview).toBeGreaterThanOrEqual(1);
    });

    it('never links an unverified Web Chat visitor', async () => {
        const webchat: any = await Lead.findById(ids.webchat._id).lean();
        expect(webchat.customerId).toBeUndefined();
        expect(webchat.customerLink.reason).toBe('unverified_contact');
        const a = await profile(ids.customerA._id).expect(200);
        expect(a.body.data.relatedLeads.map((lead: any) => lead.id)).not.toContain(String(ids.webchat._id));
    });

    it('separates vehicles of interest from owned vehicles', async () => {
        const res = await profile(ids.customerA._id).expect(200);
        const interest = res.body.data.vehicles.interest.map((vehicle: any) => `${vehicle.year} ${vehicle.make} ${vehicle.model}`);
        expect(interest).toEqual(expect.arrayContaining(['2022 Honda CR-V', '2019 Subaru Outback']));
        expect(res.body.data.vehicles.owned).toEqual([]);
        expect(res.body.data.vehicles.ownedAvailable).toBe(false);
        expect(res.body.data.summary.verifiedVehicles).toBeNull();
    });

    it('lists only appointments from linked leads', async () => {
        const res = await profile(ids.customerA._id).expect(200);
        const titles = res.body.data.appointments.map((appointment: any) => appointment.title).sort();
        expect(titles).toEqual(['Delivery Outback', 'Test drive CR-V']);
        expect(res.body.data.summary.appointments).toEqual({ total: 2, upcoming: 1, completed: 1 });
        expect(res.body.data.service.available).toBe(false);
    });

    it('counts activity only from real linked records and shows no money', async () => {
        const res = await profile(ids.customerA._id).expect(200);
        expect(res.body.data.summary.texts).toEqual({ received: 1, sent: 1 });
        expect(res.body.data.summary.calls).toBe(1);
        expect(JSON.stringify(res.body)).not.toMatch(/lifetimeValue|revenue|amount/i);
    });

    it('ignores stale or pending links', async () => {
        const res = await profile(ids.customerA._id).expect(200);
        expect(res.body.data.relatedLeads.map((lead: any) => lead.id)).not.toContain(String(ids.stale.insertedId));
    });

    it('keeps each dealership separate', async () => {
        await profile(ids.foreign._id).expect(404);
        const res = await list('?search=foreign').expect(200);
        expect(res.body.data.customers).toHaveLength(0);
        await request(app).patch(`/api/crm/customer-records/${ids.foreign._id}`).set('Authorization', `Bearer ${token}`).send({ firstName: 'Changed' }).expect(404);
        expect((await Customer.findById(ids.foreign._id).lean() as any).firstName).toBe('Jordan');
    });

    it('blocks unauthenticated and non-staff access', async () => {
        await request(app).get('/api/crm/customer-records').expect(401);
        const portal = await request(app).get('/api/crm/customer-records').set('Authorization', `Bearer ${portalToken}`);
        expect([401, 403]).toContain(portal.status);
        const portalEdit = await request(app).patch(`/api/crm/customer-records/${ids.manual._id}`).set('Authorization', `Bearer ${portalToken}`).send({ firstName: 'Hacked' });
        expect([401, 403]).toContain(portalEdit.status);
        expect((await Customer.findById(ids.manual._id).lean() as any).firstName).toBe('Riley');
    });

    it('edits customer information through the existing validation', async () => {
        const res = await request(app).patch(`/api/crm/customer-records/${ids.manual._id}`).set('Authorization', `Bearer ${token}`)
            .send({ firstName: ' Riley ', lastName: 'Manual-Lee', address: { street: '9 Elm St', city: 'Provo', state: 'UT', postalCode: '84601' }, notes: 'Prefers mornings', lifetimeValue: 99999, organizationId: String(otherOrg._id), isActive: false, dateOfBirth: '1990-01-01' })
            .expect(200);
        expect(res.body.data.customer.addressText).toBe('9 Elm St, Provo, UT 84601');
        const saved: any = await Customer.findById(ids.manual._id).lean();
        expect(saved.firstName).toBe('Riley');
        expect(saved.lastName).toBe('Manual-Lee');
        expect(saved.organizationId).toBe(String(org._id));
        expect(saved.isActive).toBe(true);
        expect(saved.dateOfBirth).toBeUndefined();
        expect(saved.stats?.lifetimeValue || 0).toBe(0);
    });

    it('refuses contact details that belong to another customer and invalid contact', async () => {
        await request(app).patch(`/api/crm/customer-records/${ids.manual._id}`).set('Authorization', `Bearer ${token}`).send({ email: mail('jordan.b') }).expect(409);
        await request(app).patch(`/api/crm/customer-records/${ids.manual._id}`).set('Authorization', `Bearer ${token}`).send({ email: 'not-an-email' }).expect(400);
        await request(app).patch(`/api/crm/customer-records/${ids.manual._id}`).set('Authorization', `Bearer ${token}`).send({ firstName: '   ' }).expect(400);
        expect((await Customer.findById(ids.manual._id).lean() as any).normalizedEmail).toBeFalsy();
    });

    it('searches by name, email and phone, and pages safely', async () => {
        const byEmail = await list(`?search=${encodeURIComponent(`jordan.b.${stamp}`)}`).expect(200);
        expect(byEmail.body.data.customers.map((customer: any) => customer.id)).toEqual([String(ids.customerB._id)]);
        const byPhone = await list('?search=(801)%20555-0173&status=all').expect(200);
        expect(byPhone.body.data.customers.map((customer: any) => customer.id)).toEqual([String(ids.manual._id)]);
        const pageOne = await list('?limit=2&page=1&sort=name&status=all').expect(200);
        const pageTwo = await list('?limit=2&page=2&sort=name&status=all').expect(200);
        expect(pageOne.body.data.customers).toHaveLength(2);
        expect(pageOne.body.data.total).toBe(4);
        expect(pageTwo.body.data.customers.map((c: any) => c.id)).not.toEqual(expect.arrayContaining(pageOne.body.data.customers.map((c: any) => c.id)));
        await list('?search=%28.*%29%5B').expect(200);
    });

    it('reports list counts from linked leads only', async () => {
        const res = await list(`?search=${encodeURIComponent(`jordan.a.${stamp}`)}`).expect(200);
        const row = res.body.data.customers[0];
        expect(row.leads).toEqual({ total: 3, open: 2, closed: 1 });
        expect(row.vehiclesOfInterest).toBe(2);
        expect(row.lastActivity).toBeTruthy();
        expect(JSON.stringify(row)).not.toMatch(/lifetimeValue/);
    });

    it('sorts Recent activity by the newest customer activity on linked leads', async () => {
        await Lead.updateOne({ _id: ids.single._id }, { $set: { 'followUp.lastCustomerActivityAt': new Date(Date.now() + 60_000) } });
        const first = await list('?sort=recent&status=all').expect(200);
        expect(first.body.data.customers[0].id).toBe(String(ids.customerSingle._id));
        await Lead.updateOne({ _id: ids.multiC._id }, { $set: { 'followUp.lastCustomerActivityAt': new Date(Date.now() + 120_000) } });
        await Lead.collection.updateOne({ _id: ids.stale.insertedId }, { $set: { 'followUp.lastCustomerActivityAt': new Date(Date.now() + 600_000) } });
        const second = await list('?sort=recent&status=all').expect(200);
        expect(second.body.data.customers.slice(0, 2).map((c: any) => c.id)).toEqual([String(ids.customerA._id), String(ids.customerSingle._id)]);
        expect(second.body.data.total).toBe(4);
        const paged = await list('?sort=recent&status=all&limit=1&page=2').expect(200);
        expect(paged.body.data.customers.map((c: any) => c.id)).toEqual([String(ids.customerSingle._id)]);
        expect(paged.body.data.customers[0].firstName).toBe('Morgan');
        expect(paged.body.data.customers[0].leads.total).toBe(1);
    });

    it('handles missing contact information', async () => {
        const res = await profile(ids.manual._id).expect(200);
        expect(res.body.data.customer.email).toBe('');
        expect(res.body.data.customer.hasValidPhone).toBe(true);
    });
});
