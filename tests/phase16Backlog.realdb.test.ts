import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import tokenService from '../src/services/token.service';

const stamp = Date.now();
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000);

describe('Phase 16 QA backlog fixes (real database)', () => {
    let org: any;
    let otherOrg: any;
    let admin: any;
    let token: string;
    const ids: Record<string, any> = {};

    const leadDoc = (doc: Record<string, unknown>) => ({
        organizationId: org._id,
        createdBy: admin._id,
        channel: 'email',
        source: 'Manual Entry',
        status: 'New',
        ...doc,
    });

    beforeAll(async () => {
        if (mongoose.connection.readyState !== 1) await mongoose.connection.asPromise();
        org = await Organization.create({ name: 'Phase 16 Org', slug: `phase16-${stamp}`, status: 'active' });
        otherOrg = await Organization.create({ name: 'Phase 16 Other Org', slug: `phase16-other-${stamp}`, status: 'active' });
        admin = await User.create({
            email: `phase16-admin-${stamp}@example.com`, password: 'Password123!', name: 'Phase Sixteen Admin', role: 'admin',
            organizationId: org._id, organizationRole: 'admin', emailVerified: true, onboardingCompleted: true, isActive: true,
        });
        token = tokenService.generateAccessToken(admin);

        await Lead.insertMany([
            leadDoc({ firstName: 'Ana', lastName: 'Grouptest', email: `g1.${stamp}@example.com`, status: 'New' }),
            leadDoc({ firstName: 'Ben', lastName: 'Grouptest', email: `g2.${stamp}@example.com`, status: 'Viewed' }),
            leadDoc({ firstName: 'Cy', lastName: 'Grouptest', email: `g3.${stamp}@example.com`, status: 'Bad Lead' }),
            leadDoc({ firstName: 'Di', lastName: 'Grouptest', email: `g4.${stamp}@example.com`, status: 'Bought Elsewhere' }),
            leadDoc({ firstName: 'Ed', lastName: 'Grouptest', email: `g5.${stamp}@example.com`, status: 'Sold' }),
        ]);

        ids.waitA = await Lead.create(leadDoc({
            firstName: 'Waiting', lastName: 'Waittest', email: `w1.${stamp}@example.com`, status: 'New', createdAt: hoursAgo(30),
            followUp: { lastCustomerActivityAt: hoursAgo(3) },
        }));
        ids.waitB = await Lead.create(leadDoc({
            firstName: 'Longest', lastName: 'Waittest', email: `w2.${stamp}@example.com`, status: 'Contacted', createdAt: hoursAgo(20),
            followUp: { lastCustomerActivityAt: hoursAgo(5), lastRepResponseAt: hoursAgo(6) },
        }));
        ids.waitC = await Lead.create(leadDoc({
            firstName: 'Answered', lastName: 'Waittest', email: `w3.${stamp}@example.com`, status: 'Contacted', createdAt: hoursAgo(50),
            followUp: { lastCustomerActivityAt: hoursAgo(10), lastRepResponseAt: hoursAgo(1) },
        }));
        ids.waitD = await Lead.create(leadDoc({
            firstName: 'Finished', lastName: 'Waittest', email: `w4.${stamp}@example.com`, status: 'Bad Lead', createdAt: hoursAgo(40),
            followUp: { lastCustomerActivityAt: hoursAgo(40) },
        }));

        ids.searchTail = String(1000 + (stamp % 9000));
        ids.searchLead = await Lead.create(leadDoc({
            firstName: 'Sloane', lastName: `Ridley${stamp}`, phone: `+1801202${ids.searchTail}`,
            vehicle: { year: '2021', make: 'Kia', model: `Sorento${stamp}`, vin: `VIN${stamp}`, stock: `S${stamp}` },
        }));

        ids.matchLead = await Lead.create(leadDoc({ firstName: 'Rowan', lastName: 'Pike', phone: '+18015550191', address: '1234 W 800 N, Lehi, UT 84043' }));
        ids.otherAddressLead = await Lead.create(leadDoc({ firstName: 'rowan', lastName: 'pike', phone: '+18015550192', address: '55 S Main St, Orem, UT', status: 'Sold' }));
        ids.combinedLead = await Lead.create(leadDoc({
            firstName: 'Rowan', lastName: 'Pike', phone: '+18015550193', address: '1234 W 800 N, Lehi, UT',
            combinedInto: { leadId: ids.matchLead._id, at: new Date(), previousStatus: 'New' },
        }));
        ids.foreignLead = await Lead.create({
            organizationId: otherOrg._id, createdBy: admin._id, channel: 'email', source: 'Manual Entry', status: 'New',
            firstName: 'Rowan', lastName: 'Pike', phone: '+18015550194', address: '1234 W 800 N, Lehi, UT',
        });
        ids.matchCustomer = await Customer.create({
            organizationId: String(org._id), createdBy: admin._id, firstName: 'Rowan', lastName: 'Pike', phone: '+18015550195',
            address: { street: '1234 West 800 North', city: 'Lehi', state: 'UT' }, source: 'manual',
        });
        await Customer.create([
            { organizationId: String(org._id), createdBy: admin._id, firstName: 'Booker', lastName: 'One', phone: '+18015550196', source: 'booking' },
            { organizationId: String(org._id), createdBy: admin._id, firstName: 'Booker', lastName: 'Two', phone: '+18015550197', source: 'booking' },
        ]);
    });

    afterAll(async () => {
        const orgIds = [org._id, otherOrg._id];
        await Lead.deleteMany({ organizationId: { $in: orgIds } });
        await Customer.deleteMany({ organizationId: { $in: orgIds.map(String) } });
        await User.deleteMany({ _id: admin._id });
        await Organization.deleteMany({ _id: { $in: orgIds } });
    });

    const get = (path: string) => request(app).get(path).set('Authorization', `Bearer ${token}`);

    it('filters the Lead Inbox by a whole status group', async () => {
        const dead = await get('/api/leads?statusGroup=DeadLead&search=Grouptest').expect(200);
        expect(dead.body.data.total).toBe(2);
        expect(dead.body.data.leads.map((lead: any) => lead.status).sort()).toEqual(['Bad Lead', 'Bought Elsewhere']);
        const none = await get('/api/leads?statusGroup=None&search=Grouptest').expect(200);
        expect(none.body.data.leads.map((lead: any) => lead.status).sort()).toEqual(['New', 'Viewed']);
    });

    it('lets one exact status win over the group, and ignores an unknown group', async () => {
        const exact = await get('/api/leads?status=Sold&statusGroup=DeadLead&search=Grouptest').expect(200);
        expect(exact.body.data.leads.map((lead: any) => lead.status)).toEqual(['Sold']);
        const unknown = await get('/api/leads?statusGroup=toString&search=Grouptest').expect(200);
        expect(unknown.body.data.total).toBe(5);
    });

    it('puts the customer who has waited longest for a reply first', async () => {
        const res = await get('/api/leads?sortBy=waiting_longest&search=Waittest').expect(200);
        expect(res.body.data.leads.map((lead: any) => lead.firstName)).toEqual(['Longest', 'Waiting', 'Answered', 'Finished']);
        expect(res.body.data.leads[0].email).toBe(`w2.${stamp}@example.com`);
        expect(res.body.data.leads[0].waitingSince).toBeUndefined();
        const paged = await get('/api/leads?sortBy=waiting_longest&search=Waittest&limit=1&page=2').expect(200);
        expect(paged.body.data.leads.map((lead: any) => lead.firstName)).toEqual(['Waiting']);
    });

    it('finds a lead by full name, by the number as shown, and by vehicle words', async () => {
        const found = async (search: string) => {
            const res = await get(`/api/leads?search=${encodeURIComponent(search)}`).expect(200);
            return res.body.data.leads.map((lead: any) => String(lead._id));
        };
        const lead = String(ids.searchLead._id);
        expect(await found(`Sloane Ridley${stamp}`)).toEqual([lead]);
        expect(await found(`(801) 202-${ids.searchTail}`)).toEqual([lead]);
        expect(await found(`801-202-${ids.searchTail}`)).toEqual([lead]);
        expect(await found(`+1801202${ids.searchTail}`)).toEqual([lead]);
        expect(await found(`\u202A(801) 202-${ids.searchTail}\u202C`)).toEqual([lead]);
        expect(await found(`2021 Kia Sorento${stamp}`)).toEqual([lead]);
        expect(await found(`Sorento${stamp} VIN${stamp}`)).toEqual([lead]);
        expect(await found(`Sloane Nobody${stamp}`)).toEqual([]);
    });

    it('keeps the same order when leads share the same created time', async () => {
        const sameTime = new Date(Date.now() - 500 * 3600_000);
        const twins = await Lead.insertMany(Array.from({ length: 6 }, (_, index) => leadDoc({
            firstName: `Twin${index}`, lastName: 'Tiebreak', email: `t${index}.${stamp}@example.com`, createdAt: sameTime,
        })));
        const pageOne = await get('/api/leads?search=Tiebreak&sortBy=oldest&limit=3&page=1').expect(200);
        const pageTwo = await get('/api/leads?search=Tiebreak&sortBy=oldest&limit=3&page=2').expect(200);
        const seen = [...pageOne.body.data.leads, ...pageTwo.body.data.leads].map((lead: any) => String(lead._id));
        expect(seen).toEqual(twins.map((lead: any) => String(lead._id)).sort());
    });

    it('does not report a bookings count, because nothing creates booking customers', async () => {
        const res = await get('/api/customers/stats').expect(200);
        expect(res.body.data.bookings).toBeUndefined();
        expect(res.body.data.manual).toBe(1);
        expect(res.body.data.total).toBeGreaterThanOrEqual(3);
    });

    it('shows possible existing records for a scanned license, same address first', async () => {
        const res = await get(`/api/leads/possible-matches?firstName=ROWAN&lastName=pike&address=${encodeURIComponent('1234 W 800 N, LEHI, UT 84043')}`).expect(200);
        const matches = res.body.data.matches;
        expect(matches.map((match: any) => `${match.kind}:${match.id}`)).toEqual([
            `customer:${ids.matchCustomer._id}`,
            `lead:${ids.matchLead._id}`,
            `lead:${ids.otherAddressLead._id}`,
        ]);
        expect(matches.map((match: any) => match.sameAddress)).toEqual([true, true, false]);
        expect(res.body.data.checked).toBe(true);
    });

    it('does not guess without a full name and never shows another dealership', async () => {
        const noLast = await get('/api/leads/possible-matches?firstName=Rowan').expect(200);
        expect(noLast.body.data.matches).toEqual([]);
        const res = await get('/api/leads/possible-matches?firstName=Rowan&lastName=Pike').expect(200);
        const leadIds = res.body.data.matches.filter((match: any) => match.kind === 'lead').map((match: any) => match.id);
        expect(leadIds).not.toContain(String(ids.foreignLead._id));
        expect(leadIds).not.toContain(String(ids.combinedLead._id));
        expect(res.body.data.matches.every((match: any) => match.sameAddress === null)).toBe(true);
        await get('/api/leads/possible-matches?firstName=%28.*%29&lastName=%5B').expect(200);
        await request(app).get('/api/leads/possible-matches?firstName=Rowan&lastName=Pike').expect(401);
    });

    it('sends people back to Appointments with a clear result when Google sign-in is cancelled or broken', async () => {
        const cancelled = await get('/api/crm/calendar/callback?error=access_denied').expect(302);
        expect(cancelled.headers.location).toMatch(/\/crm\/appointments\?calendar=cancelled$/);
        const broken = await get('/api/crm/calendar/callback').expect(302);
        expect(broken.headers.location).toMatch(/\/crm\/appointments\?calendar=error$/);
    });
});
