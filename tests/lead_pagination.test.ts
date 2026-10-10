import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import tokenService from '../src/services/token.service';
import { LEAD_SOURCE, UNMAPPED_LEAD_SOURCE_LABEL } from '../src/constants/leadSource';

describe('Lead Pagination & Search', () => {
    let testUser: any;
    let testOrg: any;
    let token: string;

    beforeAll(async () => {
        jest.setTimeout(30000); // Increase timeout for heavy seeding
        // 1. Setup Test Org
        testOrg = await Organization.create({
            name: 'Pagination Test Org',
            slug: 'pagi-test-' + Date.now(),
            status: 'active'
        });

        // 2. Setup Test User
        testUser = await User.create({
            email: `pagi-user-${Date.now()}@example.com`,
            password: 'Password123!',
            name: 'Pagi Tester',
            role: 'admin',
            organizationId: testOrg._id,
            organizationRole: 'admin',
            emailVerified: true,
            onboardingCompleted: true,
            isActive: true
        });

        // 3. Generate Token
        token = tokenService.generateAccessToken(testUser);

        // 4. Seed 60 leads
        const leads = Array.from({ length: 60 }).map((_, i) => ({
            firstName: `Lead ${i + 1}`,
            lastName: 'Test',
            email: `lead${i + 1}@example.com`,
            organizationId: testOrg._id,
            createdBy: testUser._id,
            source: i < 30 ? 'Email' : 'ADF',
            channel: 'email',
            vehicle: { make: 'Toyota', model: 'Camry', year: '2020' },
            comments: 'Test comment'
        }));
        await Lead.insertMany(leads);
    });

    afterAll(async () => {
        // Cleanup only test data
        if (testOrg) {
            await Lead.deleteMany({ organizationId: testOrg._id });
        }
        if (testUser) {
            await User.deleteOne({ _id: testUser._id });
        }
        if (testOrg) {
            await Organization.deleteOne({ _id: testOrg._id });
        }
    });

    it('should return first page with default limit (50)', async () => {
        const res = await request(app)
            .get('/api/leads')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.leads.length).toBe(50);
        expect(res.body.data.total).toBe(60);
        expect(res.body.data.page).toBe(1);
        expect(res.body.data.pages).toBe(2);
    });

    it('should return second page with 10 leads', async () => {
        const res = await request(app)
            .get('/api/leads?page=2')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.leads.length).toBe(10);
        expect(res.body.data.page).toBe(2);
    });

    it('should filter by search query (e.g. "Lead 1")', async () => {
        // "Lead 1" matches Lead 1, Lead 10, Lead 11... Lead 19
        const res = await request(app)
            .get('/api/leads?search=Lead 1')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        // Should return multiple leads (at least 1, 10-19)
        expect(res.body.data.leads.length).toBeGreaterThan(1);
        res.body.data.leads.forEach((l: any) => {
            expect(l.firstName.toLowerCase()).toContain('lead 1');
        });
    });

    it('should return empty results for a search that matches nothing', async () => {
        const res = await request(app)
            .get('/api/leads?search=ZXYWV999')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.leads.length).toBe(0);
        expect(res.body.data.total).toBe(0);
    });
});

describe('Lead Location Filtering', () => {
    let testUser: any;
    let testOrg: any;
    let token: string;

    beforeAll(async () => {
        jest.setTimeout(30000);
        testOrg = await Organization.create({
            name: 'Location Filter Test Org',
            slug: 'loc-filter-test-' + Date.now(),
            status: 'active'
        });

        testUser = await User.create({
            email: `loc-filter-user-${Date.now()}@example.com`,
            password: 'Password123!',
            name: 'Loc Filter Tester',
            role: 'admin',
            organizationId: testOrg._id,
            organizationRole: 'admin',
            emailVerified: true,
            onboardingCompleted: true,
            isActive: true
        });

        token = tokenService.generateAccessToken(testUser);

        await Lead.insertMany([
            { firstName: 'Lehi One', lastName: 'Test', email: 'lehi1@example.com', organizationId: testOrg._id, createdBy: testUser._id, source: 'Website Chat', channel: 'webchat', location: 'Lehi', vehicle: {}, comments: '' },
            { firstName: 'Lehi Two', lastName: 'Test', email: 'lehi2@example.com', organizationId: testOrg._id, createdBy: testUser._id, source: 'Website Chat', channel: 'webchat', location: 'Lehi', vehicle: {}, comments: '' },
            { firstName: 'Orem One', lastName: 'Test', email: 'orem1@example.com', organizationId: testOrg._id, createdBy: testUser._id, source: 'Website Chat', channel: 'webchat', location: 'Orem', vehicle: {}, comments: '' },
            { firstName: 'No Location', lastName: 'Test', email: 'nolocation@example.com', organizationId: testOrg._id, createdBy: testUser._id, source: 'Inbound SMS', channel: 'sms', vehicle: {}, comments: '' },
            { firstName: 'Empty Location', lastName: 'Test', email: 'emptylocation@example.com', organizationId: testOrg._id, createdBy: testUser._id, source: 'Manual Entry', channel: 'email', location: '', vehicle: {}, comments: '' },
        ]);
    });

    afterAll(async () => {
        if (testOrg) {
            await Lead.deleteMany({ organizationId: testOrg._id });
        }
        if (testUser) {
            await User.deleteOne({ _id: testUser._id });
        }
        if (testOrg) {
            await Organization.deleteOne({ _id: testOrg._id });
        }
    });

    it('filters leads by an exact location, case-insensitively', async () => {
        const res = await request(app)
            .get('/api/leads?location=lehi')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.total).toBe(2);
        res.body.data.leads.forEach((l: any) => {
            expect(l.location).toBe('Lehi');
        });
    });

    it('returns only leads with a missing or empty location under "Unknown Location"', async () => {
        const res = await request(app)
            .get('/api/leads?location=Unknown Location')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.total).toBe(2);
        const names = res.body.data.leads.map((l: any) => l.firstName).sort();
        expect(names).toEqual(['Empty Location', 'No Location']);
    });

    it('combines a search filter with the Unknown Location filter without silently dropping the search', async () => {
        const res = await request(app)
            .get('/api/leads?search=Empty&location=Unknown Location')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.total).toBe(1);
        expect(res.body.data.leads[0].firstName).toBe('Empty Location');
    });

    it('combines a search filter with a real location filter correctly', async () => {
        const res = await request(app)
            .get('/api/leads?search=Orem&location=Lehi')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.total).toBe(0);
    });

    it('location-counts buckets missing and empty locations together under Unknown Location', async () => {
        const res = await request(app)
            .get('/api/leads/location-counts')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.counts.Lehi).toBe(2);
        expect(res.body.data.counts.Orem).toBe(1);
        expect(res.body.data.counts['Unknown Location']).toBe(2);
    });
});

describe('Lead Source and Date Filtering', () => {
    let testUser: any;
    let testOrg: any;
    let token: string;

    const day = (value: string) => new Date(`${value}T12:00:00.000Z`);

    beforeAll(async () => {
        jest.setTimeout(30000);
        testOrg = await Organization.create({
            name: 'Source Date Filter Test Org',
            slug: 'source-date-filter-test-' + Date.now(),
            status: 'active'
        });

        testUser = await User.create({
            email: `source-date-user-${Date.now()}@example.com`,
            password: 'Password123!',
            name: 'Source Date Tester',
            role: 'admin',
            organizationId: testOrg._id,
            organizationRole: 'admin',
            emailVerified: true,
            onboardingCompleted: true,
            isActive: true
        });

        token = tokenService.generateAccessToken(testUser);

        await Lead.insertMany([
            {
                firstName: 'Canonical Email',
                lastName: 'Lead',
                email: 'canonical-email@example.com',
                organizationId: testOrg._id,
                createdBy: testUser._id,
                source: LEAD_SOURCE.EMAIL_INQUIRY,
                channel: 'email',
                location: 'Orem',
                vehicle: {},
                comments: '',
                createdAt: day('2026-10-01'),
                updatedAt: day('2026-10-01'),
            },
            {
                firstName: 'Legacy Gmail',
                lastName: 'Lead',
                email: 'legacy-gmail@example.com',
                organizationId: testOrg._id,
                createdBy: testUser._id,
                source: 'Gmail Sync',
                channel: 'email',
                location: 'Orem',
                vehicle: {},
                comments: '',
                createdAt: day('2026-10-02'),
                updatedAt: day('2026-10-02'),
            },
            {
                firstName: 'Legacy Email',
                lastName: 'Lead',
                email: 'legacy-email@example.com',
                organizationId: testOrg._id,
                createdBy: testUser._id,
                source: 'Email',
                channel: 'email',
                location: 'Lehi',
                vehicle: {},
                comments: '',
                createdAt: day('2026-10-03'),
                updatedAt: day('2026-10-03'),
            },
            {
                firstName: 'Canonical Third Party',
                lastName: 'Lead',
                email: 'canonical-third-party@example.com',
                organizationId: testOrg._id,
                createdBy: testUser._id,
                source: LEAD_SOURCE.THIRD_PARTY_LEAD,
                channel: 'adf',
                location: 'Lehi',
                vehicle: {},
                comments: '',
                createdAt: day('2026-10-04'),
                updatedAt: day('2026-10-04'),
            },
            {
                firstName: 'Vendor ADF',
                lastName: 'Lead',
                email: 'vendor-adf@example.com',
                organizationId: testOrg._id,
                createdBy: testUser._id,
                source: 'AutoTrader',
                channel: 'adf',
                location: 'Lehi',
                vehicle: {},
                comments: '',
                createdAt: day('2026-10-05'),
                updatedAt: day('2026-10-05'),
            },
            {
                firstName: 'Weird Legacy',
                lastName: 'Lead',
                email: 'weird-legacy@example.com',
                organizationId: testOrg._id,
                createdBy: testUser._id,
                source: 'Some Weird Legacy Value',
                channel: 'web',
                vehicle: {},
                comments: '',
                createdAt: day('2026-10-06'),
                updatedAt: day('2026-10-06'),
            },
            {
                firstName: 'Inbound Text',
                lastName: 'Lead',
                email: 'inbound-text@example.com',
                organizationId: testOrg._id,
                createdBy: testUser._id,
                source: LEAD_SOURCE.INBOUND_SMS,
                channel: 'sms',
                vehicle: {},
                comments: '',
                createdAt: day('2026-10-07'),
                updatedAt: day('2026-10-07'),
            },
        ]);
    });

    afterAll(async () => {
        if (testOrg) {
            await Lead.deleteMany({ organizationId: testOrg._id });
        }
        if (testUser) {
            await User.deleteOne({ _id: testUser._id });
        }
        if (testOrg) {
            await Organization.deleteOne({ _id: testOrg._id });
        }
    });

    it('filters canonical and legacy email sources under Email Inquiry', async () => {
        const res = await request(app)
            .get(`/api/leads?source=${encodeURIComponent(LEAD_SOURCE.EMAIL_INQUIRY)}&limit=20`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.total).toBe(3);
        expect(res.body.data.leads.map((lead: any) => lead.firstName).sort()).toEqual([
            'Canonical Email',
            'Legacy Email',
            'Legacy Gmail',
        ]);
        res.body.data.leads.forEach((lead: any) => {
            expect(lead.source).toBe(LEAD_SOURCE.EMAIL_INQUIRY);
        });
    });

    it('filters canonical and legacy/vendor ADF sources under Third-Party Lead', async () => {
        const res = await request(app)
            .get(`/api/leads?source=${encodeURIComponent(LEAD_SOURCE.THIRD_PARTY_LEAD)}&limit=20`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.total).toBe(2);
        expect(res.body.data.leads.map((lead: any) => lead.firstName).sort()).toEqual([
            'Canonical Third Party',
            'Vendor ADF',
        ]);
        res.body.data.leads.forEach((lead: any) => {
            expect(lead.source).toBe(LEAD_SOURCE.THIRD_PARTY_LEAD);
        });
    });

    it('filters unmapped legacy sources under Other', async () => {
        const res = await request(app)
            .get(`/api/leads?source=${encodeURIComponent(UNMAPPED_LEAD_SOURCE_LABEL)}&limit=20`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.total).toBe(1);
        expect(res.body.data.leads[0].firstName).toBe('Weird Legacy');
        expect(res.body.data.leads[0].source).toBe(UNMAPPED_LEAD_SOURCE_LABEL);
    });

    it('filters by an inclusive createdAt date range', async () => {
        const res = await request(app)
            .get('/api/leads?dateFrom=2026-10-02&dateTo=2026-10-05&limit=20&sortBy=oldest')
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.total).toBe(4);
        expect(res.body.data.leads.map((lead: any) => lead.firstName)).toEqual([
            'Legacy Gmail',
            'Legacy Email',
            'Canonical Third Party',
            'Vendor ADF',
        ]);
    });

    it('combines source, date, search, location, sort, and pagination', async () => {
        const res = await request(app)
            .get(`/api/leads?source=${encodeURIComponent(LEAD_SOURCE.THIRD_PARTY_LEAD)}&dateFrom=2026-10-04&dateTo=2026-10-05&search=Lead&location=Lehi&sortBy=oldest&page=1&limit=1`)
            .set('Authorization', `Bearer ${token}`)
            .expect(200);

        expect(res.body.data.total).toBe(2);
        expect(res.body.data.pages).toBe(2);
        expect(res.body.data.leads).toHaveLength(1);
        expect(res.body.data.leads[0].firstName).toBe('Canonical Third Party');
    });

    it('rejects invalid date formats and reversed custom ranges', async () => {
        await request(app)
            .get('/api/leads?dateFrom=10-01-2026')
            .set('Authorization', `Bearer ${token}`)
            .expect(400);

        await request(app)
            .get('/api/leads?dateFrom=2026-10-08&dateTo=2026-10-01')
            .set('Authorization', `Bearer ${token}`)
            .expect(400);
    });
});
