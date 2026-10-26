import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import Appointment from '../src/models/Appointment.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import Vehicle from '../src/models/Vehicle.model';
import GarageTransfer from '../src/models/GarageTransfer.model';
import { OwnedVehicle } from '../src/models/OwnedVehicle.model';
import { ServiceRecord } from '../src/models/ServiceRecord.model';
import tokenService from '../src/services/token.service';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';

const stamp = Date.now();
const mail = (name: string) => `${name}.life.${stamp}@example.com`;
const day = 24 * 60 * 60 * 1000;
const base = Date.UTC(2026, 8, 1, 15, 0, 0);
const at = (days: number, minutes = 0) => new Date(base + days * day + minutes * 60 * 1000);

describe('Customer lifecycle profile (real database)', () => {
    let org: any;
    let otherOrg: any;
    let admin: any;
    let rep: any;
    let rep2: any;
    let portal: any;
    let token: string;
    const ids: Record<string, any> = {};

    const createLead = (doc: Record<string, unknown>) => Lead.create({
        organizationId: org._id,
        createdBy: admin._id,
        channel: 'email',
        source: 'Website Inquiry',
        status: 'New',
        ...doc,
    });

    const setHistory = (leadId: unknown, set: Record<string, unknown>) => Lead.collection.updateOne({ _id: leadId as any }, { $set: set });

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
        org = await Organization.create({ name: 'Lifecycle Org', slug: `lifecycle-${stamp}`, status: 'active' });
        otherOrg = await Organization.create({ name: 'Lifecycle Other Org', slug: `lifecycle-other-${stamp}`, status: 'active' });
        admin = await User.create({
            email: `life-admin-${stamp}@example.com`, password: 'Password123!', name: 'Life Admin', role: 'admin',
            organizationId: org._id, organizationRole: 'admin', emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        rep = await User.create({
            email: `life-rep-${stamp}@example.com`, password: 'Password123!', name: 'Casey Rep', role: 'employee',
            organizationId: org._id, emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        rep2 = await User.create({
            email: `life-rep2-${stamp}@example.com`, password: 'Password123!', name: 'Drew Rep', role: 'employee',
            organizationId: org._id, emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        portal = await User.create({
            email: mail('avery'), password: 'Password123!', name: 'Avery Lifecycle', role: 'customer',
            organizationId: org._id, emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        token = tokenService.generateAccessToken(admin);

        ids.vehicleSold = await Vehicle.collection.insertOne({ organizationId: String(org._id), vin: '1HGCM82633A00LIFE', year: 2021, make: 'Toyota', modelName: 'Tacoma', status: 'Sold', isDeleted: false, isArchived: false, createdAt: new Date(), updatedAt: new Date() });
        await Vehicle.collection.insertOne({ organizationId: String(org._id), vin: '2HKRW2H8XNH60LIFE', year: 2022, make: 'Honda', modelName: 'CR-V', status: 'Ready for Sale', isDeleted: false, isArchived: false, createdAt: new Date(), updatedAt: new Date() });
        await Vehicle.collection.insertOne({ organizationId: String(otherOrg._id), vin: '5XYZU3LB0EG0OTHER', year: 2020, make: 'Ford', modelName: 'F-150', status: 'Sold', isDeleted: false, isArchived: false, createdAt: new Date(), updatedAt: new Date() });

        ids.first = await createLead({ firstName: 'Avery', lastName: 'Lifecycle', email: mail('avery'), phone: '+18015550191', vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma', trim: 'TRD Off-Road' }, vehicleId: ids.vehicleSold.insertedId });
        ids.second = await createLead({ firstName: 'Avery', lastName: 'Lifecycle', email: mail('avery'), phone: '+18015550191', vehicle: { year: '2022', make: 'Honda', model: 'CR-V', vin: '2HKRW2H8XNH60LIFE' } });
        ids.third = await createLead({ firstName: 'Avery', lastName: 'Lifecycle', phone: '(801) 555-0191', vehicle: { year: '2020', make: 'Ford', model: 'F-150', vin: '5XYZU3LB0EG0OTHER' } });
        ids.other = await createLead({ firstName: 'Avery', lastName: 'Lifecycle', email: mail('avery.other'), phone: '+18015550192' });
        ids.conflict = await createLead({ firstName: 'Avery', lastName: 'Lifecycle', email: mail('avery'), phone: '+18015550192' });
        ids.webchat = await createLead({ firstName: 'Avery', lastName: 'Lifecycle', email: mail('avery'), channel: 'webchat', source: 'Website Chat', intakeIdentity: 'unverified' });
        ids.single = await createLead({ firstName: 'Quinn', lastName: 'Single', email: mail('quinn'), vehicle: { year: '2023', make: 'Mazda', model: 'CX-5' } });

        await setHistory(ids.first._id, {
            createdAt: at(0),
            status: 'Sold',
            statusHistory: [
                { from: 'New', to: 'Contacted', changedAt: at(1) },
                { from: 'Contacted', to: 'Sold', changedAt: at(5), reason: 'Customer signed' },
                { from: 'Sold', to: 'Sold', reason: 'missing date entry' },
            ],
            assignmentHistory: [
                { to: rep._id, changedAt: at(0, 30) },
                { from: rep._id, to: rep2._id, changedAt: at(2) },
            ],
        });
        await setHistory(ids.second._id, { createdAt: at(10), status: 'Contacted', statusHistory: [{ from: 'New', to: 'Contacted', changedAt: at(11) }] });
        await setHistory(ids.third._id, { createdAt: at(3), status: 'New', statusHistory: [] });
        await setHistory(ids.webchat._id, { createdAt: at(12) });

        ids.customer = await Customer.findOne({ organizationId: String(org._id), normalizedEmail: mail('avery') }).lean();
        ids.customerQuinn = await Customer.findOne({ organizationId: String(org._id), normalizedEmail: mail('quinn') }).lean();
        await Customer.collection.updateOne({ _id: ids.customer._id }, { $set: { createdAt: at(0), vehicleInterest: { year: '2022', make: 'Honda', model: 'CR-V' } } });
        ids.foreign = await Customer.create({ organizationId: String(otherOrg._id), createdBy: admin._id, firstName: 'Avery', lastName: 'Lifecycle', email: mail('avery'), source: 'manual' });

        await LeadInquiry.collection.insertMany([
            { organizationId: org._id, kind: 'website_inquiry', source: 'Website Inquiry', receivedAt: at(0), association: { state: 'associated', leadId: ids.first._id, outcome: 'created_lead' }, createdAt: new Date(), updatedAt: new Date() },
            { organizationId: org._id, kind: 'sms', source: 'Inbound SMS', channel: 'sms', receivedAt: at(0, 0.5), association: { state: 'associated', leadId: ids.first._id, outcome: 'appended' }, createdAt: new Date(), updatedAt: new Date() },
            { organizationId: org._id, kind: 'website_inquiry', source: 'Website Inquiry', receivedAt: at(0, 0.2), association: { state: 'associated', leadId: ids.first._id }, createdAt: new Date(), updatedAt: new Date() },
            { organizationId: org._id, kind: 'provider_inquiry', source: 'ADF Email', sourceProvider: 'AutoTrader', channel: 'adf', vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma' }, receivedAt: at(4), association: { state: 'associated', leadId: ids.first._id, outcome: 'appended' }, createdAt: new Date(), updatedAt: new Date() },
            { organizationId: org._id, kind: 'sms', source: 'Inbound SMS', receivedAt: at(6), association: { state: 'pending_review', leadId: ids.first._id }, createdAt: new Date(), updatedAt: new Date() },
            { organizationId: otherOrg._id, kind: 'sms', source: 'Inbound SMS', receivedAt: at(7), association: { state: 'associated', leadId: ids.first._id, outcome: 'appended' }, createdAt: new Date(), updatedAt: new Date() },
        ]);

        const appointments = await Appointment.create([
            { organizationId: String(org._id), createdBy: admin._id, participants: [admin._id], title: 'Test drive Tacoma', type: 'test-drive', entryType: 'appointment', status: 'completed', startTime: at(2), endTime: at(2, 60), leadId: ids.first._id, statusHistory: [{ from: 'scheduled', to: 'completed', changedAt: at(2, 90) }] },
            { organizationId: String(org._id), createdBy: admin._id, participants: [admin._id], title: 'Visit without history', type: 'in-person', entryType: 'appointment', status: 'completed', startTime: at(11), endTime: at(11, 60), leadId: ids.second._id },
            { organizationId: String(org._id), createdBy: admin._id, participants: [admin._id], title: 'Cancelled visit', type: 'in-person', entryType: 'appointment', status: 'cancelled', startTime: at(13), endTime: at(13, 60), leadId: ids.second._id, statusHistory: [{ from: 'scheduled', to: 'cancelled', changedAt: at(12, 120) }] },
            { organizationId: String(otherOrg._id), createdBy: admin._id, participants: [admin._id], title: 'Other dealership visit', type: 'in-person', entryType: 'appointment', status: 'scheduled', startTime: at(14), endTime: at(14, 60), leadId: ids.first._id },
            { organizationId: String(org._id), createdBy: admin._id, participants: [admin._id], title: 'Chat visit', type: 'in-person', entryType: 'appointment', status: 'scheduled', startTime: at(15), endTime: at(15, 60), leadId: ids.webchat._id },
        ]);
        await Appointment.collection.updateOne({ _id: appointments[0]._id }, { $set: { createdAt: at(1, 60) } });
        await Appointment.collection.updateOne({ _id: appointments[1]._id }, { $set: { createdAt: at(10, 60) } });
        await Appointment.collection.updateOne({ _id: appointments[2]._id }, { $set: { createdAt: at(10, 90) } });

        ids.owned = await OwnedVehicle.create({ userId: portal._id, vin: '1HGCM82633A00LIFE', make: 'Toyota', model: 'Tacoma', year: '2021', status: 'ACTIVE', source: 'DEALERSHIP_TRANSFER', purchaseDate: at(5) });
        await GarageTransfer.create({
            organizationId: org._id, vehicleId: ids.vehicleSold.insertedId, ownedVehicleId: ids.owned._id, customerId: portal._id, vin: '1HGCM82633A00LIFE',
            vehicleLabel: '2021 Toyota Tacoma', customerName: 'Avery Lifecycle', customerEmail: mail('avery'), performedBy: admin._id, performedByName: 'Life Admin',
        });
        await ServiceRecord.create({ vehicleId: ids.owned._id, serviceType: 'OIL_CHANGE', date: at(30), mileageAtService: 1000, locationName: 'Service Bay', serviceStatus: 'completed' });
    });

    afterAll(async () => {
        const orgIds = [org._id, otherOrg._id];
        await ServiceRecord.deleteMany({ vehicleId: ids.owned?._id });
        await GarageTransfer.deleteMany({ organizationId: { $in: orgIds } });
        await OwnedVehicle.deleteMany({ userId: portal?._id });
        await LeadInquiry.collection.deleteMany({ organizationId: { $in: orgIds } });
        await Appointment.deleteMany({ organizationId: { $in: orgIds.map(String) } });
        await Vehicle.collection.deleteMany({ organizationId: { $in: orgIds.map(String) } });
        await Lead.deleteMany({ organizationId: { $in: orgIds } });
        await Customer.deleteMany({ organizationId: { $in: orgIds.map(String) } });
        await User.deleteMany({ _id: { $in: [admin._id, rep._id, rep2._id, portal._id] } });
        await Organization.deleteMany({ _id: { $in: orgIds } });
    });

    const profile = (id: unknown) => request(app).get(`/api/crm/customer-records/${id}`).set('Authorization', `Bearer ${token}`);
    const timeline = (id: unknown, query = '') => request(app).get(`/api/crm/customer-records/${id}/timeline${query}`).set('Authorization', `Bearer ${token}`);
    const allEvents = async (id: unknown, filter = 'all') => {
        const items: any[] = [];
        let cursor = '';
        for (let guard = 0; guard < 20; guard += 1) {
            const res = await timeline(id, `?filter=${filter}&limit=3${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`).expect(200);
            items.push(...res.body.data.items);
            if (!res.body.data.nextCursor) break;
            cursor = res.body.data.nextCursor;
        }
        return items;
    };

    it('links only the verified leads to the customer', async () => {
        const res = await profile(ids.customer._id).expect(200);
        const leadIds = res.body.data.relatedLeads.map((lead: any) => lead.id).sort();
        expect(leadIds).toEqual([ids.first._id, ids.second._id, ids.third._id].map(String).sort());
        expect(res.body.data.summary.leads).toEqual({ total: 3, open: 2, closed: 1 });
    });

    it('builds a timeline of verified events newest first without duplicates', async () => {
        const items = await allEvents(ids.customer._id);
        const keys = items.map((event) => event.id);
        expect(new Set(keys).size).toBe(keys.length);
        const times = items.map((event) => new Date(event.at).getTime());
        expect([...times].sort((a, b) => b - a)).toEqual(times);
        const types = items.map((event) => event.type);
        expect(types).toEqual(expect.arrayContaining(['record_created', 'first_inquiry', 'new_inquiry', 'returning_inquiry', 'additional_inquiry', 'lead_status', 'lead_marked_sold', 'lead_assigned', 'lead_reassigned', 'test_drive_scheduled', 'appointment_scheduled']));
        expect(items.find((event) => event.type === 'record_created').at).toBe(at(0).toISOString());
    });

    it('keeps stored timestamps and never invents dates', async () => {
        const items = await allEvents(ids.customer._id);
        const sold = items.filter((event) => event.type === 'lead_marked_sold');
        expect(sold).toHaveLength(1);
        expect(sold[0].at).toBe(at(5).toISOString());
        expect(items.find((event) => event.title === 'Test drive completed').at).toBe(at(2, 90).toISOString());
        expect(items.some((event) => event.detail === 'Visit without history' && event.title === 'Appointment completed')).toBe(false);
        expect(items.find((event) => event.title === 'Appointment cancelled').at).toBe(at(12, 120).toISOString());
    });

    it('marks a lead status of Sold as not a verified purchase', async () => {
        const items = await allEvents(ids.customer._id);
        expect(items.find((event) => event.type === 'lead_marked_sold').meta.notPurchase).toBe(true);
        const res = await profile(ids.customer._id).expect(200);
        expect(res.body.data.purchases.available).toBe(false);
        expect(res.body.data.purchases.verified).toEqual([]);
        expect(res.body.data.purchases.leadsMarkedSold).toEqual([expect.objectContaining({ leadId: String(ids.first._id), status: 'Sold', markedAt: at(5).toISOString() })]);
        expect(res.body.data.summary.verifiedPurchases).toBeNull();
    });

    it('detects a returning customer only from a new lead after a recorded close', async () => {
        const res = await profile(ids.customer._id).expect(200);
        expect(res.body.data.summary.returning).toEqual({
            count: 1,
            latest: expect.objectContaining({ leadId: String(ids.second._id), previousLeadId: String(ids.first._id), previousStatus: 'Sold', previousClosedAt: at(5).toISOString() }),
        });
        const items = await allEvents(ids.customer._id, 'inquiry');
        expect(items.find((event) => event.leadId === String(ids.third._id) && event.meta.newLead).type).toBe('new_inquiry');
        expect(items.find((event) => event.leadId === String(ids.second._id) && event.meta.newLead).type).toBe('returning_inquiry');
        const quinn = await profile(ids.customerQuinn._id).expect(200);
        expect(quinn.body.data.summary.returning).toBeNull();
    });

    it('counts additional inquiries without repeating the one that created the lead', async () => {
        const res = await profile(ids.customer._id).expect(200);
        expect(res.body.data.summary.additionalInquiries).toBe(2);
        const items = await allEvents(ids.customer._id, 'inquiry');
        const additional = items.filter((event) => event.type === 'additional_inquiry');
        expect(additional.map((event) => event.at)).toEqual([at(4).toISOString(), at(0, 0.5).toISOString()]);
        expect(additional[0].detail).toContain('AutoTrader');
        expect(items.some((event) => event.at === at(0, 0.2).toISOString())).toBe(false);
    });

    it('names the people a lead was assigned to', async () => {
        const items = await allEvents(ids.customer._id, 'assignment');
        expect(items.map((event) => event.title)).toEqual(['Lead reassigned to Drew Rep', 'Lead assigned to Casey Rep']);
        expect(items[0].detail).toBe('Previously Casey Rep');
    });

    it('filters and pages without losing or repeating events', async () => {
        const firstPage = await timeline(ids.customer._id, '?limit=4').expect(200);
        expect(firstPage.body.data.items).toHaveLength(4);
        expect(firstPage.body.data.nextCursor).toBeTruthy();
        const counts = firstPage.body.data.counts;
        expect(counts.all).toBe(counts.inquiry + counts.appointment + counts.status + counts.assignment + 1);
        const everything = await allEvents(ids.customer._id);
        expect(everything).toHaveLength(counts.all);
        const appointments = await allEvents(ids.customer._id, 'appointment');
        expect(appointments).toHaveLength(counts.appointment);
        expect(appointments.every((event) => event.category === 'appointment')).toBe(true);
    });

    it('leaves out unverified, conflicting and other-dealership records', async () => {
        const items = await allEvents(ids.customer._id);
        const leadIds = new Set(items.map((event) => event.leadId).filter(Boolean));
        expect(leadIds.has(String(ids.webchat._id))).toBe(false);
        expect(leadIds.has(String(ids.conflict._id))).toBe(false);
        expect(items.some((event) => /Other dealership|Chat visit/.test(event.detail))).toBe(false);
        expect(items.filter((event) => event.type === 'additional_inquiry').every((event) => new Date(event.at).getTime() !== at(7).getTime())).toBe(true);
    });

    it('does not link a portal account, owned vehicle or service record by matching email', async () => {
        const res = await profile(ids.customer._id).expect(200);
        expect(res.body.data.vehicles.owned).toEqual([]);
        expect(res.body.data.vehicles.ownedAvailable).toBe(false);
        expect(res.body.data.service).toEqual({ available: false, records: [] });
        expect(res.body.data.summary.ownedVehicles).toBeNull();
        expect(res.body.data.summary.serviceVisits).toBeNull();
        expect(JSON.stringify(res.body.data)).not.toContain(String(portal._id));
        expect(JSON.stringify(res.body.data)).not.toContain('Service Bay');
    });

    it('shows vehicles of interest with their inventory status from this dealership only', async () => {
        const res = await profile(ids.customer._id).expect(200);
        const byModel = Object.fromEntries(res.body.data.vehicles.interest.map((vehicle: any) => [vehicle.model, vehicle]));
        expect(byModel.Tacoma).toEqual(expect.objectContaining({ trim: 'TRD Off-Road', inventoryStatus: 'Sold', leadId: String(ids.first._id) }));
        expect(byModel['CR-V'].inventoryStatus).toBe('Ready for Sale');
        expect(byModel['F-150'].inventoryStatus).toBeNull();
        expect(res.body.data.vehicles.interest).toHaveLength(3);
        expect(res.body.data.summary.vehiclesOfInterest).toBe(3);
    });

    it('refuses other dealerships and unauthenticated requests', async () => {
        await timeline(ids.foreign._id).expect(404);
        await timeline('not-an-id').expect(404);
        await request(app).get(`/api/crm/customer-records/${ids.customer._id}/timeline`).expect(401);
    });

    it('handles a customer with a single lead and no appointments', async () => {
        const res = await timeline(ids.customerQuinn._id).expect(200);
        expect(res.body.data.items.map((event: any) => event.type).sort()).toEqual(['first_inquiry', 'record_created']);
        expect(res.body.data.counts.appointment).toBe(0);
    });
});
